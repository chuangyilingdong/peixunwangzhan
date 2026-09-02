import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { ApiError, AppShell, clearSession, createApiClient, Empty, ErrorState, formatCredits, formatDate, Loading, LoginPanel, MetricCard, Notice, PageHeader, Panel, readSession, Status, writeSession } from '@platform/shared';
import '@platform/shared/styles.css';

const navigation = [{ to: '/dashboard', icon: '◈', label: '我的学习' }, { to: '/projects', icon: '✦', label: '我的项目' }, { to: '/works', icon: '▣', label: '我的作品' }, { to: '/showcase', icon: '✧', label: '作品墙' }];
const demos = [{ label: '跟随课堂学生', login: 'student-1', password: 'study123' }, { label: '自主练习学生', login: 'student-2', password: 'study123' }];

function useData(load, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const refresh = async () => {
    setState((old) => ({ ...old, loading: true, error: null }));
    try { setState({ loading: false, error: null, data: await load() }); }
    catch (error) { setState({ loading: false, error, data: null }); }
  };
  useEffect(() => { refresh(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, refresh };
}

function Dashboard({ api }) {
  const { loading, error, data, refresh } = useData(() => api.get('student/dashboard'), [api]);
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  const lessonCount = data.courses.reduce((total, course) => total + (course.lessons?.length || 0), 0);
  return <>
    <PageHeader eyebrow="我的魔法学院" title={`你好，${data.user.displayName}`} description={data.canUseNow ? '现在可以开始你的 AI 创作了。' : '等待老师开启课堂后，即可继续创作。'} />
    <div className="metrics"><MetricCard label="可用创作额度" value={formatCredits(data.user.creditsRemaining)} hint="本周期个人额度" /><MetricCard label="魔法石" value={formatCredits(data.user.magicStones)} hint="完成创作可以积累" tone="teal" /><MetricCard label="我的班级" value={data.classes.length} hint={data.classes.map((item) => item.name).join('、') || '尚未加入班级'} tone="orange" /><MetricCard label="可学课时" value={lessonCount} hint={`${data.courses.length} 个课程包`} tone="pink" /></div>
    {data.canUseNow ? <Panel title="当前课堂"><Notice tone="success">{data.activeSessions.length ? `课堂正在进行：${data.activeSessions.map((item) => item.lessonTitle || '当前课时').join('、')}` : '你的账号支持自主练习，可以随时开始创作。'}</Notice></Panel> : <Panel title="创作暂不可用"><Notice tone="warning">{data.blockReason}</Notice></Panel>}
    <Panel title="我的课程">{data.courses.length ? <div className="card-list">{data.courses.map((course) => <article className="item-card" key={course.id}><h3>{course.title}</h3><p>{course.description || '准备好用创意完成这门课吧。'}</p><ol className="course-lessons">{course.lessons.map((lesson) => <li key={lesson.id}>{lesson.title} · {lesson.durationMinutes} 分钟</li>)}</ol></article>)}</div> : <Empty title="暂无可用课程" />}</Panel>
  </>;
}

function Projects({ api }) {
  const navigate = useNavigate();
  const projects = useData(() => api.get('student/projects'), [api]);
  const dashboard = useData(() => api.get('student/dashboard'), [api]);
  const [title, setTitle] = useState('我的新创作');
  const [lessonId, setLessonId] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const lessons = dashboard.data?.courses?.flatMap((course) => course.lessons.map((lesson) => ({ ...lesson, courseTitle: course.title }))) || [];

  async function create(event) {
    event.preventDefault();
    setBusy('create');
    try {
      const chosenLesson = lessonId || lessons[0]?.id;
      const project = await api.post('student/projects', { title, courseLessonId: chosenLesson || undefined, canvasSnapshot: { nodes: [], edges: [] } });
      setTitle('我的新创作');
      projects.refresh();
      navigate(`/projects/${project.id}/canvas`);
    } catch (err) { setMessage(err.message); }
    finally { setBusy(''); }
  }

  async function useAi(project) {
    setBusy(project.id);
    try {
      const result = await api.post('ai/usage', { modality: 'TEXT', credits: 1, projectId: project.id });
      setMessage(`已记录 1 次 AI 文本创作，剩余机构积分 ${formatCredits(result.balanceAfter)}。`);
      dashboard.refresh();
    } catch (err) { setMessage(err.message); }
    finally { setBusy(''); }
  }

  async function submit(project) {
    setBusy(project.id);
    try {
      await api.post(`student/projects/${project.id}/submit`, { description: '来自学生画布的项目提交' });
      setMessage('作品已提交，等待老师点评。');
      projects.refresh();
    } catch (err) { setMessage(err.message); }
    finally { setBusy(''); }
  }

  return <>
    <PageHeader eyebrow="创作空间" title="我的项目" description="用可拖拽、可连线的魔法画布组织提示词、画面和故事。" />
    {!dashboard.loading && !dashboard.data?.canUseNow && <Notice tone="warning">{dashboard.data?.blockReason}</Notice>}
    <div className="split"><Panel title="创建项目"><form onSubmit={create}><label>项目标题<input value={title} onChange={(event) => setTitle(event.target.value)} required /></label><label>关联课时<select value={lessonId} onChange={(event) => setLessonId(event.target.value)}><option value="">自动选择首个可用课时</option>{lessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.courseTitle} · {lesson.title}</option>)}</select></label><button className="primary-button" disabled={busy === 'create'}>{busy === 'create' ? '创建中…' : '创建并打开画布'}</button></form></Panel><Panel title="创作提示"><Notice>每次保存都会在后端生成画布版本。跟随课堂账号只能在老师开启课堂后编辑或提交。</Notice>{message && <Notice tone={message.includes('已') || message.includes('记录') ? 'success' : 'danger'}>{message}</Notice>}</Panel></div>
    <Panel title="项目列表" actions={<button className="secondary-button" onClick={projects.refresh}>刷新</button>}>{projects.loading ? <Loading /> : projects.error ? <ErrorState error={projects.error} onRetry={projects.refresh} /> : projects.data.items.length ? <div className="card-list">{projects.data.items.map((project) => <article className="item-card" key={project.id}><div className="row-actions"><h3>{project.title}</h3><Status value={project.status} /></div><p>{project.courseLessonTitle || '未绑定课时'} · 版本 {project.latestVersion} · 最近保存：{formatDate(project.lastSavedAt || project.updatedAt)}</p><div className="row-actions"><button className="secondary-button" onClick={() => navigate(`/projects/${project.id}/canvas`)}>{project.status === 'DRAFT' ? '进入画布' : '查看画布'}</button>{project.status === 'DRAFT' && <><button className="secondary-button" disabled={busy === project.id} onClick={() => useAi(project)}>消耗 1 积分进行 AI 文本创作</button><button className="primary-button" disabled={busy === project.id} onClick={() => submit(project)}>提交作品</button></>}</div></article>)}</div> : <Empty title="还没有项目" body="选择一节课，开始你的第一份创作。" />}</Panel>
  </>;
}


function snapshotSummary(snapshot) {
  return {
    nodeCount: Array.isArray(snapshot?.nodes) ? snapshot.nodes.length : 0,
    edgeCount: Array.isArray(snapshot?.edges) ? snapshot.edges.length : 0,
  };
}

const NODE_TYPE_NAMES = { prompt: '提示词卡片', image: '画面卡片', character: '故事角色', scene: '故事场景', video: '故事短片', note: '创作便签' };
const CANVAS_SNAPSHOT_FORMAT = 'ai-kids-canvas-snapshot';
const MAX_CANVAS_IMPORT_BYTES = 1024 * 1024;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readImportedCanvas(payload) {
  if (!isRecord(payload) || payload.format !== CANVAS_SNAPSHOT_FORMAT || payload.formatVersion !== 1) {
    throw new Error('请选择由本平台导出的画布 JSON 文件。');
  }
  const snapshot = payload.canvasSnapshot;
  if (!isRecord(snapshot) || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
    throw new Error('导入文件缺少完整的画布节点或连线数据。');
  }
  const nodeIds = new Set();
  snapshot.nodes.forEach((node) => {
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id || nodeIds.has(node.id) || !NODE_TYPE_NAMES[node.type] || !isRecord(node.data) || !isRecord(node.position)) {
      throw new Error('导入文件包含无法识别的创作卡片。');
    }
    nodeIds.add(node.id);
  });
  const edgeIds = new Set();
  snapshot.edges.forEach((edge) => {
    if (!isRecord(edge) || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id) || typeof edge.source !== 'string' || typeof edge.target !== 'string' || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error('导入文件包含无法识别的卡片连线。');
    }
    edgeIds.add(edge.id);
  });
  const viewport = isRecord(snapshot.viewport) ? snapshot.viewport : {};
  return {
    canvasSnapshot: {
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      viewport: {
        x: Number.isFinite(Number(viewport.x)) ? Number(viewport.x) : 0,
        y: Number.isFinite(Number(viewport.y)) ? Number(viewport.y) : 0,
        zoom: Number.isFinite(Number(viewport.zoom)) ? Number(viewport.zoom) : 1,
      },
    },
    source: isRecord(payload.project) ? payload.project : {},
  };
}

function nodeDescription(node) {
  const data = node?.data || {};
  const title = data.name || data.place || data.caption || data.text || data.title || node?.id || '未命名卡片';
  return `${NODE_TYPE_NAMES[node?.type] || '创作卡片'}：${String(title).slice(0, 36)}`;
}

function edgeDescription(edge) {
  return `连线：${edge?.source || '未知节点'} → ${edge?.target || '未知节点'}`;
}

function collectionChanges(from, to, describe) {
  const addedItems = [...to.entries()].filter(([key]) => !from.has(key)).map(([, item]) => describe(item));
  const removedItems = [...from.entries()].filter(([key]) => !to.has(key)).map(([, item]) => describe(item));
  const changedItems = [...to.entries()]
    .filter(([key, item]) => from.has(key) && JSON.stringify(from.get(key)) !== JSON.stringify(item))
    .map(([, item]) => `${describe(item)}（内容、位置或属性已调整）`);
  return {
    added: addedItems.length,
    removed: removedItems.length,
    changed: changedItems.length,
    addedItems,
    removedItems,
    changedItems,
  };
}

function snapshotDiff(fromSnapshot, toSnapshot) {
  const byId = (items) => new Map((items || []).map((item) => [item.id, item]));
  return {
    nodes: collectionChanges(byId(fromSnapshot?.nodes), byId(toSnapshot?.nodes), nodeDescription),
    edges: collectionChanges(byId(fromSnapshot?.edges), byId(toSnapshot?.edges), edgeDescription),
  };
}

function ChangeList({ title, items }) {
  if (!items?.length) return null;
  return <div className="item-card"><strong>{title}（{items.length}）</strong><ul className="course-lessons">{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul></div>;
}

function CanvasWorkspace({ api }) {
  const navigate = useNavigate();
  const { projectId } = useParams();
  const project = useData(() => api.get(`student/projects/${projectId}`), [api, projectId]);
  const history = useData(() => api.get(`student/projects/${projectId}/snapshots`), [api, projectId]);
  const generations = useData(() => api.get(`ai/generations?projectId=${encodeURIComponent(projectId)}`), [api, projectId]);
  const [draft, setDraft] = useState(null);
  const [canvasSnapshot, setCanvasSnapshot] = useState(null);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const [savedSignature, setSavedSignature] = useState('');
  const [saveLabel, setSaveLabel] = useState('画布编辑');
  const [busy, setBusy] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState(null);
  const [renamingVersion, setRenamingVersion] = useState(null);
  const [savingRenameVersion, setSavingRenameVersion] = useState(null);
  const [renameLabel, setRenameLabel] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewingVersion, setPreviewingVersion] = useState(null);
  const [exportingVersion, setExportingVersion] = useState(null);
  const [importingCanvas, setImportingCanvas] = useState(false);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('');
  const [comparison, setComparison] = useState(null);
  const [comparing, setComparing] = useState(false);
  const [message, setMessage] = useState('');
  const [generationForm, setGenerationForm] = useState({ modality: 'IMAGE', prompt: '', title: '' });
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!project.data) return;
    const snapshot = project.data.canvasSnapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    setCanvasSnapshot(snapshot);
    setCanvasVersion(project.data.latestVersion);
    setDraft(snapshot);
    setSavedSignature(JSON.stringify(snapshot));
  }, [project.data?.id, project.data?.latestVersion]);

  useEffect(() => {
    const items = history.data?.items || [];
    if (!items.length) return;
    const latest = String(items[0].version);
    const previous = String(items[1]?.version || items[0].version);
    setCompareFrom((current) => items.some((item) => String(item.version) === current) ? current : previous);
    setCompareTo((current) => items.some((item) => String(item.version) === current) ? current : latest);
  }, [history.data?.items]);

  if (project.loading) return <Loading label="正在打开魔法画布…" />;
  if (project.error) return <ErrorState error={project.error} onRetry={project.refresh} />;
  const editable = project.data.status === 'DRAFT';
  const changed = draft && JSON.stringify(draft) !== savedSignature;
  const historyItems = history.data?.items || [];

  async function save() {
    if (!editable || !draft) return;
    setBusy(true);
    try {
      const label = saveLabel.trim() || '画布编辑';
      const saved = await api.put(`student/projects/${project.data.id}`, { canvasSnapshot: draft, label });
      setCanvasSnapshot(saved.canvasSnapshot);
      setCanvasVersion(saved.latestVersion);
      setSavedSignature(JSON.stringify(saved.canvasSnapshot));
      setDraft(saved.canvasSnapshot);
      setSaveLabel('画布编辑');
      setMessage(`已保存为版本 ${saved.latestVersion}：${label}。`);
      history.refresh();
      project.refresh();
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  }

  async function restore(version) {
    if (!editable) return;
    setRestoringVersion(version);
    try {
      const snapshot = await api.get(`student/projects/${project.data.id}/snapshots/${version}`);
      const saved = await api.put(`student/projects/${project.data.id}`, {
        canvasSnapshot: snapshot.canvasSnapshot,
        label: `恢复版本 ${version}`,
      });
      setCanvasSnapshot(saved.canvasSnapshot);
      setCanvasVersion(saved.latestVersion);
      setSavedSignature(JSON.stringify(saved.canvasSnapshot));
      setDraft(saved.canvasSnapshot);
      setMessage(`已将版本 ${version} 恢复为新的版本 ${saved.latestVersion}。`);
      history.refresh();
      project.refresh();
    } catch (err) { setMessage(err.message); }
    finally { setRestoringVersion(null); }
  }

  async function previewVersion(version) {
    setPreviewingVersion(version);
    try {
      const snapshot = await api.get(`student/projects/${project.data.id}/snapshots/${version}`);
      setPreview(snapshot);
    } catch (err) { setMessage(err.message); }
    finally { setPreviewingVersion(null); }
  }

  async function renameVersion(version) {
    const label = renameLabel.trim();
    if (!label) { setMessage('请填写版本名称。'); return; }
    setSavingRenameVersion(version);
    try {
      await api.put(`student/projects/${project.data.id}/snapshots/${version}`, { label });
      setMessage(`版本 ${version} 已重命名。`);
      setRenamingVersion(null);
      setRenameLabel('');
      history.refresh();
    } catch (err) { setMessage(err.message); }
    finally { setSavingRenameVersion(null); }
  }

  async function exportVersion(version) {
    setExportingVersion(version);
    try {
      const snapshot = await api.get(`student/projects/${project.data.id}/snapshots/${version}`);
      const payload = {
        format: 'ai-kids-canvas-snapshot',
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        project: { id: project.data.id, title: project.data.title, version: snapshot.version, label: snapshot.label || null },
        canvasSnapshot: snapshot.canvasSnapshot,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const safeTitle = String(project.data.title || 'canvas').replace(/[\\/:*?"<>|]/g, '_');
      link.href = url;
      link.download = `${safeTitle}-v${snapshot.version}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage(`版本 ${version} 已导出为 JSON 文件。`);
    } catch (err) { setMessage(err.message); }
    finally { setExportingVersion(null); }
  }

  async function importCanvas(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !editable) return;
    if (file.size > MAX_CANVAS_IMPORT_BYTES) { setMessage('导入文件不能超过 1MB。'); return; }
    setImportingCanvas(true);
    try {
      const imported = readImportedCanvas(JSON.parse(await file.text()));
      setCanvasSnapshot(imported.canvasSnapshot);
      setDraft(imported.canvasSnapshot);
      setCanvasRevision((value) => value + 1);
      const sourceTitle = String(imported.source.title || '').trim();
      const sourceVersion = Number(imported.source.version);
      const suggestedLabel = sourceTitle ? `导入：${sourceTitle}${Number.isFinite(sourceVersion) ? ` v${sourceVersion}` : ''}`.slice(0, 100) : '导入画布快照';
      setSaveLabel(suggestedLabel);
      setMessage('已导入画布快照；请确认内容后保存为当前项目的新版本。');
    } catch (err) { setMessage(err instanceof Error ? err.message : '导入画布失败，请检查 JSON 文件。'); }
    finally { setImportingCanvas(false); }
  }

  function addGeneratedAsset(asset, prompt, modality) {
    const type = modality === 'IMAGE' ? 'image' : modality === 'VIDEO' ? 'video' : modality === 'TEXT' ? 'prompt' : 'note';
    const nodeId = `${type}-asset-${Date.now().toString(36)}`;
    const data = type === 'image'
      ? { title: asset.label || 'AI 画面素材', emoji: '✨', caption: prompt, assetUrl: asset.assetUrl, previewUrl: asset.previewUrl }
      : type === 'video'
        ? { title: asset.label || 'AI 故事短片', text: prompt, assetUrl: asset.assetUrl, previewUrl: asset.previewUrl }
        : type === 'prompt'
          ? { title: asset.label || 'AI 灵感提示词', text: prompt, assetUrl: asset.assetUrl }
          : { title: asset.label || 'AI 创作素材', text: `${modality}：${prompt}`, assetUrl: asset.assetUrl, previewUrl: asset.previewUrl };
    const current = draft || canvasSnapshot || project.data.canvasSnapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const next = { ...current, nodes: [...(current.nodes || []), { id: nodeId, type, position: { x: 160 + ((current.nodes?.length || 0) % 4) * 280, y: 120 + ((current.nodes?.length || 0) % 3) * 180 }, data }] };
    setCanvasSnapshot(next); setDraft(next); setCanvasRevision((value) => value + 1);
  }

  async function generateMaterial(event) {
    event.preventDefault();
    if (!editable) return;
    setGenerating(true);
    try {
      const result = await api.post('ai/generations', { projectId: project.data.id, ...generationForm });
      const asset = result.assets?.[0];
      if (asset) addGeneratedAsset(asset, generationForm.prompt, generationForm.modality);
      setGenerationForm((current) => ({ ...current, prompt: '', title: '' }));
      setMessage(`已生成 ${result.job.modality} 模拟素材，并已添加到未保存画布。`);
      generations.refresh();
    } catch (err) { setMessage(err.message); }
    finally { setGenerating(false); }
  }

  async function compareVersions() {
    if (!compareFrom || !compareTo) { setMessage('请选择两个版本后再比较。'); return; }
    if (compareFrom === compareTo) { setMessage('请选择两个不同的版本进行比较。'); return; }
    setComparing(true);
    try {
      const [fromSnapshot, toSnapshot] = await Promise.all([
        api.get(`student/projects/${project.data.id}/snapshots/${compareFrom}`),
        api.get(`student/projects/${project.data.id}/snapshots/${compareTo}`),
      ]);
      setComparison({ from: fromSnapshot, to: toSnapshot, diff: snapshotDiff(fromSnapshot.canvasSnapshot, toSnapshot.canvasSnapshot) });
    } catch (err) { setMessage(err.message); }
    finally { setComparing(false); }
  }

  return <>
    <PageHeader eyebrow="魔法画布" title={project.data.title} description={editable ? '把提示词、画面和故事卡片连起来，完成属于你的创作流程。' : '项目已提交，当前以只读方式展示画布内容。'} actions={<><button className="secondary-button" onClick={() => navigate('/projects')}>返回项目</button>{editable && <button className="primary-button" onClick={save} disabled={busy || !draft || !changed}>{busy ? '保存中…' : changed ? '保存画布' : '已保存'}</button>}</>} />
    <div className="row-actions canvas-meta"><Status value={project.data.status} /><span className="muted">关联课时：{project.data.courseLessonTitle || '—'}</span><span className="muted">当前版本：{project.data.latestVersion}</span><span className="muted">{changed ? '画布有未保存修改' : '所有修改已保存'}</span></div>
    {message && <Notice tone={message.includes('已保存') || message.includes('已将') || message.includes('已重命名') || message.includes('已导出') || message.includes('已导入') || message.includes('已生成') ? 'success' : 'danger'}>{message}</Notice>}
    {editable && <Panel title="导入画布快照"><label>选择已导出的 JSON 文件<input type="file" accept="application/json,.json" disabled={importingCanvas} onChange={importCanvas} /></label><Notice>仅支持本平台导出的画布 JSON，最大 1MB。导入只会替换当前未保存草稿；确认后点击“保存画布”才会创建当前项目的新版本。</Notice></Panel>}
    {editable && <Panel title="下一次保存的版本名称"><label>版本名称<input value={saveLabel} maxLength={100} onChange={(event) => setSaveLabel(event.target.value)} placeholder="例如：完成小狐狸分镜" /></label><Notice>保存时会使用这个名称创建一个新版本；不填写时默认标记为“画布编辑”。</Notice></Panel>}
    {editable && <Panel title="AI 素材工坊（本地模拟）"><form onSubmit={generateMaterial}><label>素材类型<select value={generationForm.modality} onChange={(event) => setGenerationForm((current) => ({ ...current, modality: event.target.value }))}><option value="IMAGE">画面素材</option><option value="VIDEO">故事短片</option><option value="MUSIC">音乐素材</option><option value="PODCAST">播客素材</option><option value="DUBBING">配音素材</option><option value="TEXT">灵感提示词</option></select></label><label>素材名称（可选）<input value={generationForm.title} maxLength={100} placeholder="例如：星光森林封面" onChange={(event) => setGenerationForm((current) => ({ ...current, title: event.target.value }))} /></label><label>描述你的素材<textarea value={generationForm.prompt} required maxLength={2000} placeholder="例如：夜晚的星光森林里，小狐狸举着发光的种子。" onChange={(event) => setGenerationForm((current) => ({ ...current, prompt: event.target.value }))} /></label><button className="primary-button" disabled={generating}>{generating ? '生成中…' : '生成并加入画布（1 积分）'}</button></form><Notice tone="warning">当前为可配置的本地 mock 供应商：会生成可追踪的模拟素材和预览，不会调用外部模型或上传真实文件。配置实际供应商适配器与对象存储后可无缝替换。</Notice>{generations.data?.items?.length ? <div className="card-list">{generations.data.items.slice(0, 3).map((job) => <article className="item-card" key={job.id}><div className="row-actions"><strong>{job.modality} · {job.prompt.slice(0, 40)}</strong><Status value={job.status === 'SUCCEEDED' ? 'APPROVED' : job.status === 'FAILED' ? 'REJECTED' : 'PENDING'} /></div>{job.assets?.[0]?.previewUrl && <img src={job.assets[0].previewUrl} alt={job.assets[0].label} style={{ width: '100%', maxWidth: 360, borderRadius: 12, marginTop: 8 }} />}<p className="muted">{job.provider} · {formatDate(job.createdAt)} · {job.creditsCharged} 积分</p></article>)}</div> : null}</Panel>}
    <CanvasEditor key={`${project.data.id}-${canvasVersion}-${canvasRevision}`} initialSnapshot={canvasSnapshot || project.data.canvasSnapshot} readOnly={!editable} onChange={setDraft} />
    <div className="split">
      <Panel title="版本历史" actions={<button className="secondary-button" onClick={history.refresh}>刷新历史</button>}>
        {history.loading ? <Loading label="正在读取版本历史…" /> : history.error ? <ErrorState error={history.error} onRetry={history.refresh} /> : historyItems.length ? <div className="card-list">{historyItems.map((snapshot) => <article className="item-card" key={snapshot.id}><div className="row-actions"><strong>版本 {snapshot.version}</strong><span className="muted">{formatDate(snapshot.createdAt)}</span></div>{renamingVersion === snapshot.version ? <div className="row-actions"><input value={renameLabel} maxLength={100} onChange={(event) => setRenameLabel(event.target.value)} aria-label={`版本 ${snapshot.version} 名称`} /><button className="primary-button" disabled={savingRenameVersion === snapshot.version} onClick={() => renameVersion(snapshot.version)}>{savingRenameVersion === snapshot.version ? '保存中…' : '保存名称'}</button><button className="secondary-button" onClick={() => { setRenamingVersion(null); setRenameLabel(''); }}>取消</button></div> : <p>{snapshot.label || `版本 ${snapshot.version}`} {snapshot.actorName ? `· 保存人：${snapshot.actorName}` : ''}</p>}<div className="row-actions"><button className="text-button" disabled={previewingVersion === snapshot.version} onClick={() => previewVersion(snapshot.version)}>{previewingVersion === snapshot.version ? '打开中…' : '预览'}</button><button className="text-button" disabled={exportingVersion === snapshot.version} onClick={() => exportVersion(snapshot.version)}>{exportingVersion === snapshot.version ? '导出中…' : '导出 JSON'}</button>{editable && <><button className="text-button" onClick={() => { setRenamingVersion(snapshot.version); setRenameLabel(snapshot.label || `版本 ${snapshot.version}`); }}>改名</button><button className="secondary-button" disabled={Boolean(restoringVersion)} onClick={() => restore(snapshot.version)}>{restoringVersion === snapshot.version ? '恢复中…' : '恢复为新版本'}</button></>}</div></article>)}</div> : <Empty title="还没有历史版本" body="保存画布后，这里会出现可恢复的版本。" />}
      </Panel>
      <Panel title="版本差异概览"><p className="muted">选择两个历史版本，快速查看卡片和连线的增加、删除与修改情况。</p>{historyItems.length > 1 ? <><label>起始版本<select value={compareFrom} onChange={(event) => setCompareFrom(event.target.value)}>{historyItems.map((item) => <option key={`from-${item.id}`} value={item.version}>版本 {item.version} · {item.label || '未命名'}</option>)}</select></label><label>目标版本<select value={compareTo} onChange={(event) => setCompareTo(event.target.value)}>{historyItems.map((item) => <option key={`to-${item.id}`} value={item.version}>版本 {item.version} · {item.label || '未命名'}</option>)}</select></label><button className="secondary-button" disabled={comparing} onClick={compareVersions}>{comparing ? '比较中…' : '比较版本'}</button>{comparison && <><p><strong>版本 {comparison.from.version}</strong> → <strong>版本 {comparison.to.version}</strong></p><div className="metrics"><MetricCard label="新增卡片" value={comparison.diff.nodes.added} hint={`新增连线 ${comparison.diff.edges.added}`} /><MetricCard label="删除卡片" value={comparison.diff.nodes.removed} hint={`删除连线 ${comparison.diff.edges.removed}`} tone="orange" /><MetricCard label="修改卡片" value={comparison.diff.nodes.changed} hint={`修改连线 ${comparison.diff.edges.changed}`} tone="teal" /><MetricCard label="目标内容" value={snapshotSummary(comparison.to.canvasSnapshot).nodeCount} hint={`${snapshotSummary(comparison.to.canvasSnapshot).edgeCount} 条连线`} tone="pink" /></div><details><summary>查看逐项变更详情</summary><div className="card-list"><ChangeList title="新增卡片" items={comparison.diff.nodes.addedItems} /><ChangeList title="删除卡片" items={comparison.diff.nodes.removedItems} /><ChangeList title="修改卡片" items={comparison.diff.nodes.changedItems} /><ChangeList title="新增连线" items={comparison.diff.edges.addedItems} /><ChangeList title="删除连线" items={comparison.diff.edges.removedItems} /><ChangeList title="修改连线" items={comparison.diff.edges.changedItems} />{!comparison.diff.nodes.added && !comparison.diff.nodes.removed && !comparison.diff.nodes.changed && !comparison.diff.edges.added && !comparison.diff.edges.removed && !comparison.diff.edges.changed && <p className="muted">两个版本的画布内容相同。</p>}</div></details></>}</> : <Empty title="至少保存两个版本后才能比较" />}</Panel>
    </div>
    {preview && <Panel title={`版本 ${preview.version} 只读预览`} actions={<button className="secondary-button" onClick={() => setPreview(null)}>关闭预览</button>}><div className="row-actions canvas-meta"><span className="muted">{preview.label || `版本 ${preview.version}`}</span><span className="muted">{formatDate(preview.createdAt)}</span></div><CanvasEditor key={`preview-${preview.id}`} initialSnapshot={preview.canvasSnapshot} readOnly /></Panel>}
    {editable && <Notice>提示：恢复不会覆盖旧版本，而是会将选中的历史画布另存为一个新版本。保存画布后，再回到“我的项目”提交作品；作品会使用最新保存的画布版本。</Notice>}
  </>;
}
function nodeFeedbackLabel(snapshot, nodeId) {
  const node = snapshot?.nodes?.find((item) => item.id === nodeId);
  const data = node?.data || {};
  return data.name || data.place || data.caption || data.text || data.title || '关联画布卡片';
}

function Works({ api }) {
  const { loading, error, data, refresh } = useData(() => api.get('student/works?includeSnapshot=true'), [api]);
  const [selectedWork, setSelectedWork] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  async function openFeedback(work) {
    setSelectedWork(work); setAnnotationsLoading(true);
    try { setAnnotations((await api.get(`student/works/${work.id}/annotations`)).items || []); }
    finally { setAnnotationsLoading(false); }
  }
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  return <><PageHeader eyebrow="成果展" title="我的作品" description="查看老师的整体点评与画布卡片反馈；发布后的优秀作品会出现在机构作品墙。" /><Panel title="提交记录" actions={<button className="secondary-button" onClick={refresh}>刷新</button>}>{data.items.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>课程 / 课时</th><th>提交时间</th><th>状态</th><th>老师点评</th><th>反馈</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><div className="muted">{item.description || '暂无说明'}</div></td><td>{item.courseLessonTitle || item.lessonTitle || '—'}</td><td>{formatDate(item.submittedAt)}</td><td><Status value={item.status} /></td><td>{item.teacherComment || '等待老师点评'}</td><td><button className="text-button" onClick={() => openFeedback(item)}>查看画布反馈</button></td></tr>)}</tbody></table></div> : <Empty title="还没有提交作品" body="在项目画布完成创作后，提交给老师点评吧。" />}</Panel>{selectedWork && <Panel title={`老师反馈 · ${selectedWork.title}`} actions={<button className="secondary-button" onClick={() => setSelectedWork(null)}>关闭</button>}><CanvasEditor key={`feedback-${selectedWork.id}`} initialSnapshot={selectedWork.canvasSnapshot} readOnly />{annotationsLoading ? <Loading label="正在读取反馈…" /> : annotations.length ? <div className="card-list">{annotations.map((annotation) => <article className="item-card" key={annotation.id}><div className="row-actions"><strong>{annotation.nodeId ? `卡片反馈：${nodeFeedbackLabel(selectedWork.canvasSnapshot, annotation.nodeId)}` : '整体补充反馈'}</strong><Status value={annotation.resolvedAt ? 'APPROVED' : 'PENDING'} /></div><p>{annotation.content}</p><p className="muted">{annotation.authorName} · {formatDate(annotation.createdAt)}{annotation.resolvedAt ? ' · 老师已标记完成' : ''}</p></article>)}</div> : <Empty title="老师暂未添加画布批注" body="整体点评会显示在提交记录中。" />}</Panel>}</>;
}

function Showcase({ api }) {
  const { loading, error, data, refresh } = useData(() => api.get('student/showcase'), [api]);
  const [work, setWork] = useState(null);
  async function openWork(item) { setWork(await api.get(`student/showcase/${item.id}`)); }
  if (loading) return <Loading label="正在打开作品墙…" />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  return <><PageHeader eyebrow="机构作品墙" title="优秀作品展示" description="这里只展示本机构老师已发布的作品，供同学们互相学习创作思路。" /><Panel title="已发布作品" actions={<button className="secondary-button" onClick={refresh}>刷新</button>}>{data.items.length ? <div className="card-list">{data.items.map((item) => <article className="item-card" key={item.id}><div className="row-actions"><h3>{item.title}</h3><Status value={item.status} /></div><p>{item.description || '这位同学完成了一份精彩创作。'}</p><p className="muted">创作者：{item.studentName || '同学'} · {item.courseLessonTitle || '创作作品'} · {formatDate(item.reviewedAt || item.submittedAt)}</p><button className="secondary-button" onClick={() => openWork(item)}>查看作品</button></article>)}</div> : <Empty title="作品墙正在筹备" body="老师发布优秀作品后，会显示在这里。" />}</Panel>{work && <Panel title={`作品预览 · ${work.title}`} actions={<button className="secondary-button" onClick={() => setWork(null)}>关闭</button>}><p className="muted">创作者：{work.studentName || '同学'} · {work.courseLessonTitle || '创作作品'}</p><CanvasEditor key={`showcase-${work.id}`} initialSnapshot={work.canvasSnapshot} readOnly /></Panel>}</>;
}

function StudentCourses({ api }) {
  const state = useData(() => api.get('student/courses'), [api]);
  if (state.loading) return <Loading />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.refresh} />;
  const summary = state.data.summary || {};
  return <><PageHeader eyebrow="学习地图" title="我的课程" description="查看机构为你开通的课程与课时，按老师安排进入对应项目创作。" actions={<button className="secondary-button" onClick={state.refresh}>刷新</button>} /><div className="metrics"><MetricCard label="课程包" value={summary.courseCount || 0} hint="当前可学习课程" /><MetricCard label="已分配课时" value={summary.assignedLessonCount || 0} hint={'已开始 ' + (summary.startedLessonCount || 0) + ' 节'} tone="teal" /><MetricCard label="已提交" value={summary.submittedLessonCount || 0} hint={'已发布 ' + (summary.publishedLessonCount || 0) + ' 节'} tone="orange" /><MetricCard label="课堂进行中" value={summary.activeLessonCount || 0} hint={'加入 ' + (summary.classCount || 0) + ' 个班级'} tone="pink" /></div>{state.data.items?.length ? <div className="card-list">{state.data.items.map((course) => <Panel key={course.id} title={course.title} actions={<span className="status success">{course.progress?.submittedPercent || 0}% 已提交</span>}><p className="muted">{course.description || '准备好用创意完成这门课吧。'} · {course.classes?.map((item) => item.name).join('、') || '课程已分配'}</p><div className="table-wrap"><table><thead><tr><th>课时</th><th>时长</th><th>项目</th><th>作品</th><th>状态</th><th>最近活动</th></tr></thead><tbody>{course.lessons?.map((lesson) => <tr key={lesson.id}><td><strong>{lesson.title}</strong><div className="muted">{lesson.summary || '跟随课程完成一次创作。'}</div></td><td>{lesson.durationMinutes ? lesson.durationMinutes + ' 分钟' : '—'}</td><td>{lesson.projectCount || 0}</td><td>{lesson.workCount || 0}</td><td>{lesson.activeNow ? <span className="status success">课堂进行中</span> : <Status value={lesson.workStatus || '待开始'} />}</td><td>{formatDate(lesson.lastActivityAt)}</td></tr>)}</tbody></table></div></Panel>)}</div> : <Panel title="我的课程"><Empty title="暂无可用课程" body="机构为你分配课程后，会显示在这里。" /></Panel>}</>;
}

function StudentCredits({ api }) {
  const [days, setDays] = useState('30'); const [modality, setModality] = useState(''); const [status, setStatus] = useState('');
  const params = new URLSearchParams({ days }); if (modality) params.set('modality', modality); if (status) params.set('status', status);
  const state = useData(() => api.get('student/credits?' + params.toString()), [api, days, modality, status]);
  if (state.loading) return <Loading />; if (state.error) return <ErrorState error={state.error} onRetry={state.refresh} />;
  const data = state.data; const period = data.period || {}; const usage = data.usage || {};
  return <><PageHeader eyebrow="创作能量" title="AI / 魔法石" description="查看本周期额度、套餐能力与 AI 创作使用记录。" actions={<button className="secondary-button" onClick={state.refresh}>刷新</button>} /><div className="metrics"><MetricCard label="可用额度" value={formatCredits(period.remaining)} hint={'总额度 ' + formatCredits(period.allowance)} /><MetricCard label="本周期已用" value={formatCredits(period.used)} hint={'最近 ' + (usage.days || days) + ' 天使用 ' + formatCredits(usage.totalCredits)} tone="teal" /><MetricCard label="魔法石" value={formatCredits(data.magicStones)} hint="个人创作成就" tone="orange" /><MetricCard label="课堂会话" value={data.activeSessions?.length || 0} hint={data.usageScope === 'HOME_PRACTICE' ? '支持自主练习' : '跟随老师课堂使用'} tone="pink" /></div><div className="split"><Panel title="额度周期"><div className="card-list"><div className="item-card"><strong>{formatCredits(period.remaining)} / {formatCredits(period.allowance)} 可用</strong><p className="muted">基础额度 {formatCredits((period.allowance || 0) - (period.bonus || 0) - (period.boost || 0))} · 奖励 {formatCredits(period.bonus)} · 加成 {formatCredits(period.boost)}</p><p className="muted">周期：{formatDate(period.start)} 至 {formatDate(period.reset)}</p>{period.expired && <Notice tone="warning">当前额度周期已到期，请联系机构管理员更新套餐。</Notice>}</div>{data.package ? <div className="item-card"><strong>{data.package.name}</strong><p className="muted">套餐月度额度 {formatCredits(data.package.monthlyCredits)}，有效期 {data.package.durationDays} 天</p><p>{Object.entries(data.package.capabilities || {}).filter(([, enabled]) => enabled).map(([key]) => key.replace('allow','')).join('、') || '基础文字能力'}</p></div> : <Notice>当前账号未绑定机构套餐。</Notice>}</div></Panel><Panel title="筛选用量"><div className="form-grid"><label>统计范围<select value={days} onChange={(event) => setDays(event.target.value)}><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option><option value="365">最近 365 天</option></select></label><label>素材类型<select value={modality} onChange={(event) => setModality(event.target.value)}><option value="">全部类型</option>{['TEXT','IMAGE','MUSIC','VIDEO','PODCAST','DUBBING'].map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="SUCCESS">成功</option><option value="FAILED">失败</option><option value="BLOCKED">已拦截</option></select></label></div></Panel></div><Panel title={'用量明细 · ' + (usage.recordCount || 0) + ' 条'}>{usage.items?.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>项目 / 课时</th><th>课堂</th><th>消耗</th><th>状态</th></tr></thead><tbody>{usage.items.map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}</td><td>{item.modality}<div className="muted">{item.model}</div></td><td>{item.projectTitle || '未关联项目'}<div className="muted">{item.courseLessonTitle || '—'}</div></td><td>{item.className || '自主练习'}</td><td>{formatCredits(item.credits)}</td><td><Status value={item.status} />{item.failCode && <div className="muted">{item.failCode}</div>}</td></tr>)}</tbody></table></div> : <Empty title="暂无用量记录" body="选择其他时间范围，或完成一次 AI 创作后再来查看。" />}</Panel></>;
}

function StudentAccount({ api, onRelogin }) {
  const state = useData(() => api.get('student/account'), [api]); const [displayName, setDisplayName] = useState(''); const [profileMessage, setProfileMessage] = useState(''); const [profileBusy, setProfileBusy] = useState(false); const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' }); const [passwordMessage, setPasswordMessage] = useState(''); const [passwordBusy, setPasswordBusy] = useState(false); const [revokeBusy, setRevokeBusy] = useState('');
  useEffect(() => { if (state.data?.user) setDisplayName(state.data.user.displayName || ''); }, [state.data?.user?.id, state.data?.user?.displayName]);
  if (state.loading) return <Loading />; if (state.error) return <ErrorState error={state.error} onRetry={state.refresh} />;
  const data = state.data;
  async function saveProfile(event) { event.preventDefault(); setProfileBusy(true); setProfileMessage(''); try { await api.put('student/account/profile', { displayName }); await state.refresh(); setProfileMessage('资料已更新。'); } catch (error) { setProfileMessage(error.message); } finally { setProfileBusy(false); } }
  async function changePassword(event) { event.preventDefault(); setPasswordBusy(true); setPasswordMessage(''); try { const result = await api.put('student/account/password', passwords); if (result.reloginRequired) onRelogin(); } catch (error) { setPasswordMessage(error.message); setPasswordBusy(false); } }
  async function revoke(session) { setRevokeBusy(session.id); try { const result = await api.put('student/account/sessions/' + session.id + '/revoke', {}); if (result.reloginRequired) onRelogin(); else state.refresh(); } catch (error) { setPasswordMessage(error.message); } finally { setRevokeBusy(''); } }
  return <><PageHeader eyebrow="账号中心" title="个人账号" description="管理你的个人资料、机构归属和登录安全。" actions={<button className="secondary-button" onClick={state.refresh}>刷新</button>} /><div className="split"><Panel title="个人资料"><form onSubmit={saveProfile}><label>显示名称<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength="60" required /></label><button className="primary-button" disabled={profileBusy}>{profileBusy ? '保存中…' : '保存资料'}</button></form>{profileMessage && <Notice tone={profileMessage.includes('已') ? 'success' : 'danger'}>{profileMessage}</Notice>}</Panel><Panel title="账号状态"><div className="item-card"><p><strong>{data.user.login}</strong> · <Status value={data.user.status} /></p><p className="muted">角色：学生 · 注册于 {formatDate(data.user.createdAt)}</p><p className="muted">账号有效期：{formatDate(data.user.expiresAt)}</p></div></Panel></div><div className="split"><Panel title="机构与班级"><p><strong>{data.organization?.name || '未归属机构'}</strong></p>{data.classes?.length ? <div className="card-list">{data.classes.map((item) => <div className="item-card" key={item.id}><strong>{item.name}</strong><p className="muted">老师：{item.teacherName || '—'} · {item.usageMode || '跟随课堂'}</p></div>)}</div> : <Empty title="暂未加入班级" />}</Panel><Panel title="修改密码"><form onSubmit={changePassword}><label>当前密码<input type="password" value={passwords.currentPassword} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} required /></label><label>新密码<input type="password" value={passwords.newPassword} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} minLength="8" maxLength="72" required /><small className="muted">8-72 位，必须同时包含字母和数字</small></label><button className="primary-button" disabled={passwordBusy}>{passwordBusy ? '修改中…' : '修改密码并重新登录'}</button></form>{passwordMessage && <Notice tone="danger">{passwordMessage}</Notice>}</Panel></div><Panel title="登录会话"><p className="muted">当前会话：{data.currentSessionId}</p>{data.sessions?.length ? <div className="table-wrap"><table><thead><tr><th>客户端</th><th>创建时间</th><th>过期时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.sessions.map((session) => <tr key={session.id}><td>{session.clientType}</td><td>{formatDate(session.createdAt)}</td><td>{formatDate(session.expiresAt)}</td><td>{session.current ? <span className="status success">当前会话</span> : <span className="status muted">有效</span>}</td><td><button className="text-button" disabled={revokeBusy === session.id} onClick={() => revoke(session)}>{session.current ? '退出此设备' : '撤销'}</button></td></tr>)}</tbody></table></div> : <Empty title="暂无有效会话" />}</Panel></>;
}

function StudentPage({ kind, api }) {
  const pages = { help: ['帮助与下载', '查看客户端安装、课堂登录和创作常见问题。', ['客户端下载', '支持 macOS Apple 芯片与 Windows 64 位'], ['创作指南', '学会用中文描述、预览、修改并发布作品']] };
  const [title, description, cards] = pages[kind];
  return <><PageHeader eyebrow="AI魔法学院 · 小小创作者" title={title} description={description} actions={<a className="primary-button" href="http://localhost:5176/download">下载客户端 ↗</a>} /><div className="metrics">{cards.map((item, index) => <MetricCard key={item[0]} label={item[0]} value={index ? '可查看' : '下载'} hint={item[1]} tone={index ? 'teal' : 'violet'} />)}</div><Panel title="创作小提示"><Notice tone="info">如需课堂登录或下载客户端，请联系老师获取对应指引。</Notice></Panel></>;
}

function App() {
  const [session, setSession] = useState(readSession);
  const navigate = useNavigate();
  const api = useMemo(() => createApiClient({ getToken: () => session?.token, onUnauthorized: () => { clearSession(); setSession(null); navigate('/login'); } }), [session?.token, navigate]);
  useEffect(() => { if (session?.token) api.me().then((user) => setSession(writeSession({ ...session, user, organization: user.organization }))).catch(() => {}); }, [session?.token]);
  async function login(credentials) { const data = await api.login(credentials); if (data.user.role !== 'STUDENT') throw new ApiError('该账号没有学生创作权限', { code: 'ROLE_MISMATCH' }); setSession(writeSession(data)); navigate('/dashboard'); }
  async function logout() { try { await api.logout(); } catch { /* local logout still succeeds */ } clearSession(); setSession(null); navigate('/login'); }
  if (!session) return <Routes><Route path="*" element={<LoginPanel title="学生创作空间" description="在 AI 魔法学院中学习、创作并分享你的作品。" clientType="student" demos={demos} onLogin={login} />} /></Routes>;
  if (session.user?.role !== 'STUDENT') return <LoginPanel title="学生创作空间" description="当前会话没有学生创作权限。" clientType="student" demos={demos} onLogin={login} />;
  return <AppShell product="AI 魔法学院" roleLabel="小小创作者" user={session.user} navigation={navigation} onLogout={logout}><Routes><Route path="/dashboard" element={<Dashboard api={api} />} /><Route path="/projects" element={<Projects api={api} />} /><Route path="/projects/:projectId/canvas" element={<CanvasWorkspace api={api} />} /><Route path="/works" element={<Works api={api} />} /><Route path="/showcase" element={<Showcase api={api} />} /><Route path="/courses" element={<StudentCourses api={api} />} /><Route path="/credits" element={<StudentCredits api={api} />} /><Route path="/account" element={<StudentAccount api={api} onRelogin={() => { clearSession(); setSession(null); navigate('/login'); }} />} /><Route path="/help" element={<StudentPage kind="help" api={api} />} /><Route path="*" element={<Navigate to="/dashboard" replace />} /></Routes></AppShell>;
}

createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
