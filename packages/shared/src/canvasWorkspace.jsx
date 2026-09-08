import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CanvasEditor, createCanvasTemplate } from '@platform/canvas';
import { formatDate } from './auth.js';
import { ErrorState, Loading, Notice, Empty, Panel, PageHeader, Status } from './ui.jsx';
import { useData } from './classroom.jsx';

// Signatures and helpers (原独立学生端逻辑，已并入官网学习页)
function canvasContentSignature(snapshot) {
  if (!snapshot) return '';
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
  return JSON.stringify({
    nodes: nodes.map((node) => ({ id: node.id, type: node.type, data: node.data || node.props || {} })),
    edges: edges.map((edge) => ({ source: edge.source, target: edge.target, sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle })),
    viewport: snapshot.viewport || null,
  });
}

function snapshotDiff(fromSnapshot, toSnapshot) {
  const fromNodes = new Map((fromSnapshot?.nodes || []).map((node) => [node.id, node]));
  const toNodes = new Map((toSnapshot?.nodes || []).map((node) => [node.id, node]));
  const added = []; const removed = []; const changed = [];
  for (const [id, node] of toNodes.entries()) if (!fromNodes.has(id)) added.push(node);
  for (const [id, node] of fromNodes.entries()) if (!toNodes.has(id)) removed.push(node);
  for (const [id, node] of toNodes.entries()) {
    const prev = fromNodes.get(id);
    if (!prev) continue;
    if (JSON.stringify(prev.data || prev.props || {}) !== JSON.stringify(node.data || node.props || {})) changed.push(node);
  }
  const fromEdges = new Set((fromSnapshot?.edges || []).map((e) => JSON.stringify({ s: e.source, t: e.target, sh: e.sourceHandle, th: e.targetHandle })));
  const toEdges = new Set((toSnapshot?.edges || []).map((e) => JSON.stringify({ s: e.source, t: e.target, sh: e.sourceHandle, th: e.targetHandle })));
  let addedEdges = 0; let removedEdges = 0;
  for (const key of toEdges) if (!fromEdges.has(key)) addedEdges++;
  for (const key of fromEdges) if (!toEdges.has(key)) removedEdges++;
  return { added, removed, changed, addedEdges, removedEdges };
}

function nodeDescription(snapshot, nodeId) {
  const node = (snapshot?.nodes || []).find((n) => n.id === nodeId);
  if (!node) return '节点';
  const source = node.data || node.props || {};
  const label = source.title || source.text || source.caption || source.name || source.label || '';
  return (label || node.id || '').slice(0, 40);
}

function edgeDescription(snapshot, edge) {
  return `${nodeDescription(snapshot, edge.source)} → ${nodeDescription(snapshot, edge.target)}`;
}

function collectionChanges(diff) {
  const list = [];
  if (diff.added.length) list.push(`新增 ${diff.added.length} 个节点`);
  if (diff.removed.length) list.push(`移除 ${diff.removed.length} 个节点`);
  if (diff.changed.length) list.push(`调整 ${diff.changed.length} 个节点`);
  if (diff.addedEdges) list.push(`新增 ${diff.addedEdges} 条连接`);
  if (diff.removedEdges) list.push(`移除 ${diff.removedEdges} 条连接`);
  return list.join('，');
}

function ChangeList({ diff }) {
  if (!diff) return null;
  if (!diff.added.length && !diff.removed.length && !diff.changed.length && !diff.addedEdges && !diff.removedEdges) {
    return <p className="muted">本次没有结构性变化。</p>;
  }
  return <ul className="change-list">
    {diff.added.map((n) => <li key={'add-'+n.id}>新增节点 {n.id}</li>)}
    {diff.removed.map((n) => <li key={'rem-'+n.id}>移除节点 {n.id}</li>)}
    {diff.changed.map((n) => <li key={'chg-'+n.id}>调整节点 {n.id}</li>)}
    {diff.addedEdges ? <li>新增 {diff.addedEdges} 条连接</li> : null}
    {diff.removedEdges ? <li>移除 {diff.removedEdges} 条连接</li> : null}
  </ul>;
}

export function CanvasWorkspace({ api, ...props }) {
  const navigate = useNavigate();
  const paramsFromUrl = useParams(); const projectId = props?.params?.projectId || paramsFromUrl?.projectId;
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
  const [toolPanel, setToolPanel] = useState(null);
  const [promptTarget, setPromptTarget] = useState(null);

  useEffect(() => {
    if (!project.data) return;
    const snapshot = project.data.canvasSnapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    setCanvasSnapshot(snapshot);
    setCanvasVersion(project.data.latestVersion);
    setDraft(snapshot);
    setSavedSignature(canvasContentSignature(snapshot));
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
  const changed = draft && canvasContentSignature(draft) !== savedSignature;
  const historyItems = history.data?.items || [];

  async function save() {
    if (!editable || !draft) return;
    setBusy(true);
    try {
      const label = saveLabel.trim() || '画布编辑';
      const saved = await api.put(`student/projects/${project.data.id}`, { canvasSnapshot: draft, label });
      setCanvasSnapshot(saved.canvasSnapshot);
      setCanvasVersion(saved.latestVersion);
      setSavedSignature(canvasContentSignature(saved.canvasSnapshot));
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
      setSavedSignature(canvasContentSignature(saved.canvasSnapshot));
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
    const generatedText = asset.metadata?.text || prompt;
    const data = type === 'image'
      ? { title: asset.label || 'AI 画面素材', emoji: '✨', caption: prompt, assetUrl: asset.assetUrl, previewUrl: asset.previewUrl }
      : type === 'video'
        ? { title: asset.label || 'AI 故事短片', text: generatedText, assetUrl: asset.assetUrl, previewUrl: asset.previewUrl }
        : type === 'prompt'
          ? { title: asset.label || 'AI 灵感提示词', text: generatedText, assetUrl: asset.assetUrl }
          : { title: asset.label || 'AI 创作素材', text: `${modality}：${generatedText}`, assetUrl: asset.assetUrl, previewUrl: asset.previewUrl };
    const current = draft || canvasSnapshot || project.data.canvasSnapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const next = { ...current, nodes: [...(current.nodes || []), { id: nodeId, type, position: { x: 160 + ((current.nodes?.length || 0) % 4) * 280, y: 120 + ((current.nodes?.length || 0) % 3) * 180 }, data }] };
    setCanvasSnapshot(next); setDraft(next); setCanvasRevision((value) => value + 1);
  }

  async function generateCanvasNode({ modality, prompt, title, sourceAssetUrl = '' }) {
    if (!editable) throw new Error('当前作品不可编辑');
    // 比例/清晰度/时长/音频由服务端按课时配置取值，这里只提交内容与首帧来源。
    const queued = await api.post('ai/generations/async', { projectId: project.data.id, modality, prompt, title, sourceAssetUrl });
    let result = queued.job;
    for (let attempt = 0; attempt < 150 && !['SUCCEEDED', 'FAILED'].includes(result.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      result = await api.get(`ai/generations/history/${encodeURIComponent(result.id)}`);
    }
    if (result.status !== 'SUCCEEDED') throw new Error(result.errorMessage || '生成仍在进行中，请稍后刷新查看');
    const asset = result.assets?.[0];
    if (!asset) throw new Error('AI 未返回可用素材');
    generations.refresh();
    return asset;
  }
  async function generateMaterial(event) {
    event.preventDefault();
    if (!editable) return;
    setGenerating(true);
    try {
      const queued = await api.post('ai/generations/async', { projectId: project.data.id, ...generationForm });
      let result = queued.job;
      for (let attempt = 0; attempt < 150 && !['SUCCEEDED', 'FAILED'].includes(result.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        result = await api.get(`ai/generations/history/${encodeURIComponent(result.id)}`);
      }
      if (result.status !== 'SUCCEEDED') throw new Error(result.errorMessage || '生成仍在进行中，请稍后刷新查看');
      const asset = result.assets?.[0];
      if (asset) addGeneratedAsset(asset, generationForm.prompt, generationForm.modality);
      setGenerationForm((current) => ({ ...current, prompt: '', title: '' }));
      setMessage(`已完成 ${result.modality} 素材生成，并已添加到未保存画布。`);
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

  async function submitWork() {
    if (!editable || !draft) return;
    setBusy(true);
    try {
      const result = await api.post(`student/projects/${project.data.id}/submit`, { canvasSnapshot: draft, description: `完成${project.data.courseLessonTitle || '本节课堂'}作品` });
      setCanvasSnapshot(result.project.canvasSnapshot);
      setDraft(result.project.canvasSnapshot);
      setSavedSignature(canvasContentSignature(result.project.canvasSnapshot));
      setMessage('作品已提交，老师可以看到你的课堂作品了。');
      project.refresh();
    } catch (err) { setMessage(err.message); }
    finally { setBusy(false); }
  }

  function useTemplate() {
    const template = createCanvasTemplate('adventure');
    setCanvasSnapshot(template); setDraft(template); setCanvasRevision((value) => value + 1);
    setMessage('已放入一份创作底稿，完成后请保存。');
  }

  function addLessonMaterialToCanvas(material) {
    if (!editable || !material) return;
    const current = draft || canvasSnapshot || project.data.canvasSnapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const snapshot = material.snapshot && typeof material.snapshot === 'object' ? material.snapshot : {};
    const sourceData = snapshot.data || snapshot.props || {};
    const materialType = String(material.materialType || snapshot.type || 'NOTE').toUpperCase();
    const type = snapshot.type || (materialType === 'IMAGE' ? 'image' : materialType === 'VIDEO' ? 'video' : materialType === 'CHARACTER' ? 'character' : materialType === 'SCENE' ? 'scene' : materialType === 'TEXT' || materialType === 'PROMPT' ? 'prompt' : 'note');
    const fallbackData = type === 'image'
      ? { title: material.title, emoji: '✨', caption: material.description || '' }
      : type === 'video'
        ? { title: material.title, text: material.description || '' }
        : type === 'character'
          ? { title: material.title, emoji: '🧒', name: '', trait: material.description || '' }
          : type === 'scene'
            ? { title: material.title, emoji: '🌲', place: material.description || '', mood: '' }
            : { title: material.title, text: material.description || '' };
    const node = {
      id: `lesson-material-${material.id}-${Date.now().toString(36)}`,
      type,
      position: { x: 160 + ((current.nodes?.length || 0) % 4) * 280, y: 120 + ((current.nodes?.length || 0) % 3) * 180 },
      data: { ...fallbackData, ...sourceData, title: material.title || sourceData.title, lessonMaterialId: material.id, isLessonMaterial: true },
    };
    const next = { ...current, nodes: [...(current.nodes || []), node] };
    setCanvasSnapshot(next); setDraft(next); setCanvasRevision((value) => value + 1);
    setMessage(`已将“${material.title || '课堂素材'}”加入画布。`);
  }

  const generationSlots = project.data.generationSlots || { image: { count: 0 }, video: { count: 0 } };

  function slotNodesOfType(slotType) {
    const current = draft || canvasSnapshot || project.data.canvasSnapshot || { nodes: [] };
    return (current.nodes || []).filter((node) => node.data?.slotType === slotType);
  }

  function addSlotToCanvas(slotType) {
    if (!editable) return;
    // 能力未开放时也不允许加框体，避免出现学生无法生成的空框体。
    if (!(Array.isArray(project.data.capabilities) ? project.data.capabilities : ['text']).includes(slotType)) { setMessage('本课未开放该 AI 能力。'); return; }
    const slot = generationSlots[slotType] || {};
    const limit = Number(slot.count || 0);
    const used = slotNodesOfType(slotType).length;
    const label = slotType === 'image' ? '生图框体' : '生视频框体';
    if (limit <= 0) { setMessage(`本课未配置「${label}」。`); return; }
    if (used >= limit) { setMessage(`本课「${label}」最多 ${limit} 个。`); return; }
    const current = draft || canvasSnapshot || project.data.canvasSnapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const node = {
      id: `${slotType}-slot-${Date.now().toString(36)}`,
      type: slotType,
      position: { x: 160 + ((current.nodes?.length || 0) % 4) * 280, y: 120 + ((current.nodes?.length || 0) % 3) * 180 },
      data: {
        title: label, slotType,
        aspectRatio: slot.aspectRatio || '', resolution: slot.resolution || slot.size || '', model: slot.model || '',
        ...(slotType === 'video' ? { durationSeconds: slot.durationSeconds || 5, audio: slot.audio === true, requiresFirstFrame: slot.requiresFirstFrame === true } : {}),
        caption: '', text: '',
      },
    };
    const next = { ...current, nodes: [...(current.nodes || []), node] };
    setCanvasSnapshot(next); setDraft(next); setCanvasRevision((value) => value + 1);
    setMessage(`已添加「${label}」，请填写提示词或从素材插入。`);
  }

  function openPromptInsert(material) {
    if (!editable) return;
    const targets = [...slotNodesOfType('image'), ...slotNodesOfType('video')];
    if (!targets.length) { setMessage('画布上还没有框体，请先从「生成框体」添加。'); return; }
    setPromptTarget({ material, targets });
  }

  function insertPromptToSlot(nodeId) {
    const material = promptTarget?.material;
    if (!material || !nodeId) return;
    const text = material.snapshot?.content || material.description || material.title || '';
    const current = draft || canvasSnapshot || project.data.canvasSnapshot;
    if (!current) return;
    const next = { ...current, nodes: (current.nodes || []).map((node) => {
      if (node.id !== nodeId) return node;
      const field = node.type === 'video' ? 'text' : 'caption';
      return { ...node, data: { ...node.data, [field]: text } };
    }) };
    setCanvasSnapshot(next); setDraft(next); setCanvasRevision((value) => value + 1);
    setPromptTarget(null);
    setMessage(`已将「${material.title}」插入所选框体。`);
  }

  const lessonTitle = project.data.courseLessonTitle || 'AI 创作课堂';
  const materialGroups = Array.isArray(project.data.materialGroups) ? project.data.materialGroups : [];
  const capabilities = Array.isArray(project.data.capabilities) && project.data.capabilities.length ? project.data.capabilities : ['text'];
  const hasNodes = Boolean((draft || canvasSnapshot)?.nodes?.length);

  return <main className="student-canvas-shell">
    <header className="student-canvas-topbar">
      <div className="student-canvas-brand"><span className="student-canvas-brand-mark">✦</span><div><strong>AI 魔法学院</strong><small>学生创作画布</small></div></div>
      <div className="student-canvas-top-title"><span>正在上课</span><strong>{lessonTitle}</strong></div>
      <div className="student-canvas-actions"><button className="ghost-canvas-button" onClick={() => navigate('/learn/canvas')}>课程大厅</button><button className="primary-canvas-button" disabled={busy || !changed} onClick={save}>{busy ? '保存中…' : '保存并退出'}</button></div>
    </header>
    <section className="student-canvas-layout">
      <aside className={`student-tool-rail ${toolPanel ? 'is-open' : ''}`}>
        <button className="student-tool-rail__toggle" type="button" onClick={() => setToolPanel((value) => value ? null : 'materials')} aria-expanded={Boolean(toolPanel)}>☰ <span>工具</span></button>
        <button className={`student-tool-button ${toolPanel === 'materials' ? 'is-active' : ''}`} type="button" onClick={() => setToolPanel((value) => value === 'materials' ? null : 'materials')}><span>▦</span><small>素材</small></button><button className={`student-tool-button ${toolPanel === 'capabilities' ? 'is-active' : ''}`} type="button" onClick={() => setToolPanel((value) => value === 'capabilities' ? null : 'capabilities')}><span>⚙</span><small>能力</small></button>
        {toolPanel === 'materials' && <div className="student-tool-drawer"><div className="student-tool-drawer__header"><div><strong>课堂素材</strong><small>点击框体或素材加入画布</small></div><button type="button" onClick={() => setToolPanel(null)}>×</button></div>{((capabilities.includes('image') && generationSlots.image.count > 0) || (capabilities.includes('video') && generationSlots.video.count > 0)) && <div className="student-material-group"><h3>生成框体</h3>{capabilities.includes('image') && generationSlots.image.count > 0 && <button className="student-material-item" type="button" disabled={!editable || slotNodesOfType('image').length >= generationSlots.image.count} onClick={() => addSlotToCanvas('image')}><span className="student-material-item__icon">▧</span><span><strong>生图框体</strong><small>{generationSlots.image.aspectRatio} · {generationSlots.image.resolution || generationSlots.image.size}{generationSlots.image.model ? ' · ' + generationSlots.image.model : ''} · 已用 {slotNodesOfType('image').length}/{generationSlots.image.count}</small></span><b>＋</b></button>}{capabilities.includes('video') && generationSlots.video.count > 0 && <button className="student-material-item" type="button" disabled={!editable || slotNodesOfType('video').length >= generationSlots.video.count} onClick={() => addSlotToCanvas('video')}><span className="student-material-item__icon">▶</span><span><strong>生视频框体</strong><small>{generationSlots.video.aspectRatio} · {generationSlots.video.resolution || generationSlots.video.size} · {generationSlots.video.durationSeconds}秒{generationSlots.video.audio ? ' · 含音频' : ''}{generationSlots.video.model ? ' · ' + generationSlots.video.model : ''} · 已用 {slotNodesOfType('video').length}/{generationSlots.video.count}</small></span><b>＋</b></button>}</div>}{materialGroups.length ? materialGroups.map((group) => <div className="student-material-group" key={group.id || group.title}><h3>{group.title}</h3>{(group.materials || []).map((material) => <button className="student-material-item" key={material.id || material.title} type="button" onClick={() => material.materialType === 'PROMPT' ? openPromptInsert(material) : addLessonMaterialToCanvas(material)}><span className="student-material-item__icon">{material.materialType === 'IMAGE' ? '▧' : material.materialType === 'VIDEO' ? '▶' : '✎'}</span><span><strong>{material.title}</strong><small>{material.materialType === 'PROMPT' ? '点击后选择插入到哪个框体' : (material.description || '点击后加入画布')}</small></span><b>＋</b></button>)}</div>) : <p className="student-tool-empty">老师还没有为本节课配置素材。</p>}</div>}{toolPanel === 'capabilities' && <div className="student-tool-drawer"><div className="student-tool-drawer__header"><div><strong>本课开放能力</strong><small>未勾选的 AI 能力不会出现在画布中</small></div><button type="button" onClick={() => setToolPanel(null)}>×</button></div><div className="student-capability-list">{[['text','AI 文字'],['image','AI 生图'],['video','AI 生视频'],['music','AI 音乐'],['podcast','AI 播客'],['dubbing','AI 配音']].map(([key,label]) => <span className={capabilities.includes(key) ? 'is-enabled' : ''} key={key}>{capabilities.includes(key) ? '✓' : '—'} {label}</span>)}</div></div>}
      </aside>
      <div className="student-canvas-main"><div className="student-canvas-heading"><div><span className="student-kicker">我的课堂画布</span><h2>{project.data.title}</h2></div><span className={`student-save-state ${changed ? 'is-dirty' : ''}`}>{changed ? '有未保存修改' : '已保存'}</span></div><div className="student-canvas-viewport"><CanvasEditor key={`${project.data.id}-${canvasVersion}-${canvasRevision}`} initialSnapshot={canvasSnapshot || project.data.canvasSnapshot} capabilities={capabilities} readOnly={!editable} allowNodeCreation={false} showStarter={false} onGenerateNode={generateCanvasNode} onChange={setDraft} /></div></div>
    </section>
    <div className="student-canvas-submitbar"><div><strong>完成作品后记得提交</strong><span>老师会根据你的画布内容进行点评</span></div><div className="student-submit-actions"><button className="secondary-button" onClick={() => navigate('/learn/canvas')}>退出课堂</button><button className="primary-canvas-button student-submit-button" disabled={!editable || busy || !draft || !hasNodes} onClick={submitWork}>{busy ? '提交中…' : '提交作品 ✨'}</button></div></div>
    {message && <div className={`student-canvas-toast ${message.includes('失败') || message.includes('错误') ? 'error' : ''}`}>{message}</div>}
    {promptTarget && <div className="student-slot-picker" role="dialog" aria-modal="true"><div className="student-slot-picker__panel"><strong>把「{promptTarget.material.title}」插入到哪个框体？</strong><div className="student-slot-picker__list">{promptTarget.targets.map((node) => <button key={node.id} type="button" onClick={() => insertPromptToSlot(node.id)}>{node.data?.title || node.type}<small>{node.type === 'video' ? '生视频' : '生图'}{node.data?.aspectRatio ? ' · ' + node.data.aspectRatio : ''}</small></button>)}</div><button type="button" className="secondary-button" onClick={() => setPromptTarget(null)}>取消</button></div></div>}
  </main>;

}

