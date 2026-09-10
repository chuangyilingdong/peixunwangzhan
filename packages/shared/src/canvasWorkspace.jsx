import { useEffect, useRef, useState } from 'react';
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

function collectionChanges(diff) {
  const list = [];
  if (diff.added.length) list.push(`新增 ${diff.added.length} 个节点`);
  if (diff.removed.length) list.push(`移除 ${diff.removed.length} 个节点`);
  if (diff.changed.length) list.push(`调整 ${diff.changed.length} 个节点`);
  if (diff.addedEdges) list.push(`新增 ${diff.addedEdges} 条连接`);
  if (diff.removedEdges) list.push(`移除 ${diff.removedEdges} 条连接`);
  return list.join('，');
}

function ChangeList({ diff, fromSnapshot, toSnapshot }) {
  if (!diff) return null;
  if (!diff.added.length && !diff.removed.length && !diff.changed.length && !diff.addedEdges && !diff.removedEdges) {
    return <p className="muted">本次没有结构性变化。</p>;
  }
  return <ul className="change-list">
    {diff.added.map((n) => <li key={'add-'+n.id}>新增节点「{nodeDescription(toSnapshot, n.id)}」</li>)}
    {diff.removed.map((n) => <li key={'rem-'+n.id}>移除节点「{nodeDescription(fromSnapshot, n.id)}」</li>)}
    {diff.changed.map((n) => <li key={'chg-'+n.id}>调整节点「{nodeDescription(toSnapshot, n.id)}」</li>)}
    {diff.addedEdges ? <li>新增 {diff.addedEdges} 条连接</li> : null}
    {diff.removedEdges ? <li>移除 {diff.removedEdges} 条连接</li> : null}
  </ul>;
}

const MAX_CANVAS_IMPORT_BYTES = 1024 * 1024;

// 校验 exportVersion 产出的 JSON：{format, formatVersion, project, canvasSnapshot}
function readImportedCanvas(parsed) {
  if (!parsed || typeof parsed !== 'object') throw new Error('导入文件不是有效的 JSON 对象。');
  if (parsed.format !== 'ai-kids-canvas-snapshot') throw new Error('导入文件不是本平台导出的画布快照。');
  if (Number(parsed.formatVersion) !== 1) throw new Error('导入文件的格式版本不受支持。');
  const snapshot = parsed.canvasSnapshot;
  if (!snapshot || !Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) throw new Error('导入文件缺少画布节点或连线。');
  return {
    canvasSnapshot: snapshot,
    source: { title: parsed.project?.title || '', version: Number(parsed.project?.version) },
  };
}

export function CanvasWorkspace({ api, ...props }) {
  const navigate = useNavigate();
  const paramsFromUrl = useParams(); const projectId = props?.params?.projectId || paramsFromUrl?.projectId;
  const project = useData(() => api.get(`student/projects/${projectId}`), [api, projectId]);
  const history = useData(() => api.get(`student/projects/${projectId}/snapshots?limit=200`), [api, projectId]);
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

  // 自动保存：改动停下来 1.2 秒就写回服务器（不递增版本号），刷新/断网不至于把画布丢光。
  const [autoSaving, setAutoSaving] = useState(false);
  const autoSaveRef = useRef({ signature: '', busy: false });
  useEffect(() => {
    if (!editable || !draft || !changed) return undefined;
    const signature = canvasContentSignature(draft);
    const timer = setTimeout(async () => {
      if (autoSaveRef.current.busy || autoSaveRef.current.signature === signature) return;
      autoSaveRef.current.busy = true;
      setAutoSaving(true);
      try {
        const saved = await api.put(`student/projects/${project.data.id}`, { canvasSnapshot: draft, autoSave: true });
        autoSaveRef.current.signature = canvasContentSignature(saved.canvasSnapshot);
        setCanvasSnapshot(saved.canvasSnapshot);
        setSavedSignature(canvasContentSignature(saved.canvasSnapshot));
      } catch { /* 自动保存失败不打扰学生：手工保存/提交时还会再写一次 */ }
      finally { autoSaveRef.current.busy = false; setAutoSaving(false); }
    }, 1200);
    return () => clearTimeout(timer);
  }, [api, changed, draft, editable, project.data?.id]);

  // 刷新后恢复生成状态：服务端已有任务的框体，把节点补回画布（生成中的显示「AI生成中…」）。
  useEffect(() => {
    if (!editable || !project.data || !generations.data) return;
    const boxes = Array.isArray(project.data.generationBoxes) ? project.data.generationBoxes : [];
    if (!boxes.length) return;
    const current = draft || canvasSnapshot || project.data.canvasSnapshot;
    if (!current) return;
    const existing = new Set((current.nodes || []).filter((node) => node.data?.boxId).map((node) => node.data.boxId));
    const missing = boxes.filter((box) => jobByBox.has(box.id) && !existing.has(box.id));
    if (!missing.length) return;
    let next = current;
    for (const box of missing) {
      const job = jobByBox.get(box.id);
      const succeeded = String(job.status) === 'SUCCEEDED';
      next = { ...next, nodes: [...(next.nodes || []), buildBoxNode(box, next, { asset: succeeded ? job.assets?.[0] : null, pending: !succeeded })] };
    }
    setCanvasSnapshot(next); setDraft(next); setCanvasRevision((value) => value + 1);
  }, [canvasSnapshot, draft, editable, generations.data, project.data]);

  // 还有任务在跑就轮询，跑完的结果会自动补到画布上
  useEffect(() => {
    if (!runningCount) return undefined;
    const timer = setInterval(() => generations.refresh(), 5000);
    return () => clearInterval(timer);
  }, [generations, runningCount]);

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

  async function generateCanvasNode({ modality, prompt, title, sourceAssetUrl = '', lastFrameAssetUrl = '', referenceAssets = [], boxId = '' }) {
    if (!editable) throw new Error('当前作品不可编辑');
    // 比例/清晰度/时长/音频由服务端按框体配置取值，这里只提交内容、来源框体与画面来源（首帧/尾帧）。
    const queued = await api.post('ai/generations/async', { projectId: project.data.id, modality, prompt, title, sourceAssetUrl, lastFrameAssetUrl, referenceAssets, boxId });
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
    if (!window.confirm('提交给老师前请确认：这是你自己的作品，并同意平台在作品广场展示。')) return;
    setBusy(true);
    try {
      const result = await api.post(`student/projects/${project.data.id}/submit`, { canvasSnapshot: draft, description: `完成${project.data.courseLessonTitle || '本节课堂'}作品`, copyrightConfirmed: true });
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
    const type = snapshot.type || (materialType === 'IMAGE' ? 'image' : materialType === 'VIDEO' ? 'video' : materialType === 'AUDIO' ? 'audio' : materialType === 'CHARACTER' ? 'character' : materialType === 'SCENE' ? 'scene' : materialType === 'TEXT' || materialType === 'PROMPT' ? 'prompt' : 'note');
    const fallbackData = type === 'image'
      ? { title: material.title, emoji: '✨', caption: material.description || '' }
      : type === 'video'
        ? { title: material.title, text: material.description || '' }
        : type === 'character'
          ? { title: material.title, emoji: '🧒', name: '', trait: material.description || '' }
          : type === 'scene'
            ? { title: material.title, emoji: '🌲', place: material.description || '', mood: '' }
            : { title: material.title, text: material.description || '' };
    // 上传的图片/视频/音频素材要带着文件进画布，否则节点是个空壳，
    // 看起来就跟没配参数的框体一样。
    const mediaUrl = String(material.assetUrl || '').trim();
    const mediaData = mediaUrl && ['image', 'video', 'audio', 'animation'].includes(type)
      ? { assetUrl: mediaUrl, previewUrl: String(snapshot.previewUrl || snapshot.preview_url || '').trim() || mediaUrl }
      : {};
    const node = {
      id: `lesson-material-${material.id}-${Date.now().toString(36)}`,
      type,
      position: { x: 160 + ((current.nodes?.length || 0) % 4) * 280, y: 120 + ((current.nodes?.length || 0) % 3) * 180 },
      data: { ...fallbackData, ...sourceData, ...mediaData, title: material.title || sourceData.title, lessonMaterialId: material.id, isLessonMaterial: true },
    };
    const next = { ...current, nodes: [...(current.nodes || []), node] };
    setCanvasSnapshot(next); setDraft(next); setCanvasRevision((value) => value + 1);
    setMessage(`已将“${material.title || '课堂素材'}”加入画布。`);
  }

  const generationBoxes = Array.isArray(project.data.generationBoxes) ? project.data.generationBoxes : [];

  function boxNodes() {
    const current = draft || canvasSnapshot || project.data.canvasSnapshot || { nodes: [] };
    return (current.nodes || []).filter((node) => node.data?.boxId);
  }

  // 服务端任务（刷新后仍在）：每个框体最多保留最新一条
  const generationJobs = Array.isArray(generations.data?.items) ? generations.data.items : [];
  const jobByBox = new Map();
  for (const job of generationJobs) {
    const boxId = String(job?.boxId || '');
    if (boxId && !jobByBox.has(boxId)) jobByBox.set(boxId, job);
  }
  const boxSucceeded = (boxId) => String(jobByBox.get(boxId)?.status || '') === 'SUCCEEDED';
  const boxRunning = (boxId) => ['QUEUED', 'RUNNING'].includes(String(jobByBox.get(boxId)?.status || ''));
  const runningCount = [...jobByBox.values()].filter((job) => ['QUEUED', 'RUNNING'].includes(String(job.status))).length;

  function boxUsed(boxId) {
    return boxNodes().some((node) => node.data.boxId === boxId) || boxSucceeded(boxId);
  }

  // 框体素材的配置存在 snapshot.box 里；服务端下发的 generationBoxes 是同一份数据的摊平视图。
  function boxForMaterial(material) {
    const fromServer = generationBoxes.find((box) => box.id === material.id);
    if (fromServer) return fromServer;
    const raw = material.snapshot?.box && typeof material.snapshot.box === 'object' ? material.snapshot.box : {};
    return {
      id: material.id, title: material.title,
      modality: String(raw.modality || '').toUpperCase(), model: raw.model || '',
      aspectRatio: raw.aspectRatio || '', resolution: raw.resolution || '',
      durationSeconds: raw.durationSeconds, audio: raw.audio === true,
      prompt: material.snapshot?.content || '', assetUrl: material.assetUrl || '',
    };
  }

  // 素材面板每行要让学生看清这个框体自己的参数（不同框体可以不一样）。
  function boxParamsLabel(box) {
    const slotType = String(box.modality || '').toLowerCase();
    if (slotType === 'text') return box.model || '写提示词让 AI 生成文字';
    if (slotType === 'music') {
      const mode = box.mode === 'DESCRIPTION' ? '描述生音乐（平台代写词）' : '歌词生音乐';
      return box.model ? `${mode} · ${box.model}` : mode;
    }
    const params = [box.aspectRatio, box.resolution];
    if (slotType === 'video') { params.push(`${box.durationSeconds}秒`); if (box.audio) params.push('含音频'); }
    if (box.model) params.push(box.model);
    return params.filter(Boolean).join(' · ');
  }

  // 按框体定义造一个画布节点（点击添加与刷新后恢复共用）。asset 有值时直接把生成结果挂上。
  function buildBoxNode(box, current, { asset = null, pending = false } = {}) {
    const slotType = String(box.modality || '').toLowerCase();
    const promptText = String(box.prompt || '');
    const assetUrl = String(asset?.assetUrl || '');
    const previewUrl = String(asset?.previewUrl || '');
    return {
      // 一个框体在画布上只对应一个节点：id 由框体 id 派生，重复点击不会多出第二个。
      id: `box-${box.id}`,
      // 画布节点类型：文字用 prompt，音乐用 audio，其余与模态同名
      type: slotType === 'text' ? 'prompt' : slotType === 'music' ? 'audio' : slotType,
      position: { x: 160 + ((current.nodes?.length || 0) % 4) * 280, y: 120 + ((current.nodes?.length || 0) % 3) * 180 },
      data: {
        title: box.title, slotType, boxId: box.id,
        aspectRatio: box.aspectRatio || '', resolution: box.resolution || '', model: box.model || '',
        referenceUrl: box.assetUrl || '',
        // 平台预填的提示词直接写进框体，学生可以改。
        text: slotType === 'image' ? '' : promptText,
        caption: slotType === 'image' ? promptText : '',
        ...(slotType === 'video' ? {
          durationSeconds: box.durationSeconds || 5,
          audio: box.audio === true,
          requiresFirstFrame: box.requiresFirstFrame === true,
          // 模型支持的输入画面方式（可多选）：文生 / 首帧 / 尾帧
          inputModes: Array.isArray(box.inputModes) ? box.inputModes : (box.requiresFirstFrame === true ? ['FIRST_FRAME'] : ['TEXT']),
        } : {}),
        ...(slotType === 'text' ? { generatedText: '' } : {}),
        // 音乐框体：歌词模式学生写词，描述模式学生写描述（歌词由平台代写）
        ...(slotType === 'music' ? { slotType: 'music', mode: box.mode === 'DESCRIPTION' ? 'DESCRIPTION' : 'LYRICS' } : {}),
        // 生成结果（刷新后恢复用）：图片/视频/音乐挂地址，文字挂生成文本
        ...(assetUrl ? { assetUrl, previewUrl: previewUrl || assetUrl } : {}),
        ...(slotType === 'text' && asset?.metadata?.text ? { generatedText: String(asset.metadata.text) } : {}),
        ...(pending ? { generationStatus: 'PENDING' } : {}),
      },
    };
  }

  function addBoxToCanvas(box) {
    if (!editable) return;
    const slotType = String(box.modality || '').toLowerCase();
    // 能力未开放时也不允许加框体，避免出现学生无法生成的空框体。
    if (!(Array.isArray(project.data.capabilities) ? project.data.capabilities : ['text']).includes(slotType)) { setMessage('本课未开放该 AI 能力。'); return; }
    if (boxUsed(box.id)) { setMessage(`「${box.title}」已经生成过了。`); return; }
    const current = draft || canvasSnapshot || project.data.canvasSnapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const node = buildBoxNode(box, current);
    const next = { ...current, nodes: [...(current.nodes || []), node] };
    setCanvasSnapshot(next); setDraft(next); setCanvasRevision((value) => value + 1);
    setMessage(`已添加「${box.title}」，请填写提示词或从素材插入。`);
  }

  function openPromptInsert(material) {
    if (!editable) return;
    const targets = boxNodes().filter((node) => ['text', 'image', 'video'].includes(node.data?.slotType));
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
      const field = node.data?.slotType === 'image' ? 'caption' : 'text';
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
        <button className={`student-tool-button ${toolPanel === 'materials' ? 'is-active' : ''}`} type="button" onClick={() => setToolPanel((value) => value === 'materials' ? null : 'materials')}><span>▦</span><small>素材</small></button><button className={`student-tool-button ${toolPanel === 'capabilities' ? 'is-active' : ''}`} type="button" onClick={() => setToolPanel((value) => value === 'capabilities' ? null : 'capabilities')}><span>⚙</span><small>能力</small></button><button className={`student-tool-button ${toolPanel === 'versions' ? 'is-active' : ''}`} type="button" onClick={() => setToolPanel((value) => value === 'versions' ? null : 'versions')}><span>⟲</span><small>版本</small></button>
        {toolPanel === 'materials' && <div className="student-tool-drawer"><div className="student-tool-drawer__header"><div><strong>课堂素材</strong><small>点击框体或素材加入画布</small></div><button type="button" onClick={() => setToolPanel(null)}>×</button></div>{materialGroups.length ? materialGroups.map((group) => <div className="student-material-group" key={group.id || group.title}><h3>{group.title}</h3>{(group.materials || []).map((material) => { const box = material.materialType === 'GENERATION_BOX' ? boxForMaterial(material) : null; if (box) { const slotType = String(box.modality || '').toLowerCase(); const enabled = capabilities.includes(slotType); const used = boxUsed(box.id); const label = slotType === 'image' ? '生图' : slotType === 'video' ? '生视频' : slotType === 'music' ? '音乐' : '文字'; const icon = slotType === 'image' ? '▧' : slotType === 'video' ? '▶' : slotType === 'music' ? '♫' : '✎'; return <button className="student-material-item" key={material.id} type="button" disabled={!editable || !enabled || used} title={enabled ? undefined : '本课未开放该 AI 能力'} onClick={() => addBoxToCanvas(box)}><span className="student-material-item__icon">{icon}</span><span><strong>{material.title}</strong><small>{label} · {boxParamsLabel(box)} · {used ? '已生成' : (boxRunning(box.id) ? '生成中…' : '未生成')}</small></span><b>＋</b></button>; } return <button className="student-material-item" key={material.id || material.title} type="button" onClick={() => material.materialType === 'PROMPT' ? openPromptInsert(material) : addLessonMaterialToCanvas(material)}><span className="student-material-item__icon">{material.materialType === 'IMAGE' ? '▧' : material.materialType === 'VIDEO' ? '▶' : '✎'}</span><span><strong>{material.title}</strong><small>{material.materialType === 'PROMPT' ? '点击后选择插入到哪个框体' : (material.description || '点击后加入画布')}</small></span><b>＋</b></button>; })}</div>) : <p className="student-tool-empty">老师还没有为本节课配置素材。</p>}</div>}{toolPanel === 'capabilities' && <div className="student-tool-drawer"><div className="student-tool-drawer__header"><div><strong>本课开放能力</strong><small>未勾选的 AI 能力不会出现在画布中</small></div><button type="button" onClick={() => setToolPanel(null)}>×</button></div><div className="student-capability-list">{[['text','AI 文字'],['image','AI 生图'],['video','AI 生视频'],['music','AI 音乐']].map(([key,label]) => <span className={capabilities.includes(key) ? 'is-enabled' : ''} key={key}>{capabilities.includes(key) ? '✓' : '—'} {label}</span>)}</div></div>}{toolPanel === 'versions' && <div className="student-tool-drawer"><div className="student-tool-drawer__header"><div><strong>版本管理</strong><small>预览 / 恢复 / 重命名 / 导出 / 对比 / 导入</small></div><button type="button" onClick={() => setToolPanel(null)}>×</button></div><div className="student-material-group"><h3>导入快照</h3><label className="student-material-item"><span className="student-material-item__icon">⇪</span><span><strong>{importingCanvas ? '导入中…' : '选择 JSON 文件'}</strong><small>仅支持本平台导出的画布快照，最大 1MB</small></span><b>＋</b><input type="file" accept="application/json,.json" disabled={!editable || importingCanvas} onChange={importCanvas} style={{ display: 'none' }} /></label></div><div className="student-material-group"><h3>版本对比</h3><div className="student-version-compare"><select value={compareFrom} aria-label="对比起始版本" onChange={(event) => setCompareFrom(event.target.value)}>{historyItems.map((item) => <option key={item.id} value={String(item.version)}>v{item.version}{item.label ? ' · ' + item.label : ''}</option>)}</select><span>→</span><select value={compareTo} aria-label="对比目标版本" onChange={(event) => setCompareTo(event.target.value)}>{historyItems.map((item) => <option key={item.id} value={String(item.version)}>v{item.version}{item.label ? ' · ' + item.label : ''}</option>)}</select><button type="button" className="secondary-button" disabled={comparing || historyItems.length < 2} onClick={compareVersions}>{comparing ? '比较中…' : '比较'}</button></div>{comparison ? <div className="student-version-diff"><p className="muted">{collectionChanges(comparison.diff) || '没有结构性变化。'}</p><ChangeList diff={comparison.diff} fromSnapshot={comparison.from.canvasSnapshot} toSnapshot={comparison.to.canvasSnapshot} /></div> : null}</div><div className="student-material-group"><h3>历史版本（{historyItems.length}）</h3>{historyItems.length ? <ul className="student-version-list">{historyItems.map((item) => <li key={item.id}><div className="student-version-meta"><strong>v{item.version}</strong>{item.label ? <span>{item.label}</span> : null}<small>{formatDate(item.createdAt)}{item.actorName ? ' · ' + item.actorName : ''}</small></div>{renamingVersion === item.version ? <div className="student-version-rename"><input value={renameLabel} maxLength={100} placeholder="版本名称" aria-label="版本名称" onChange={(event) => setRenameLabel(event.target.value)} /><button type="button" className="secondary-button" disabled={savingRenameVersion === item.version} onClick={() => renameVersion(item.version)}>{savingRenameVersion === item.version ? '保存中…' : '保存'}</button><button type="button" className="secondary-button" onClick={() => { setRenamingVersion(null); setRenameLabel(''); }}>取消</button></div> : <div className="row-actions"><button type="button" className="text-button" disabled={previewingVersion === item.version} onClick={() => previewVersion(item.version)}>{previewingVersion === item.version ? '打开中…' : '预览'}</button><button type="button" className="text-button" disabled={!editable || restoringVersion === item.version} onClick={() => restore(item.version)}>{restoringVersion === item.version ? '恢复中…' : '恢复'}</button><button type="button" className="text-button" disabled={!editable} onClick={() => { setRenamingVersion(item.version); setRenameLabel(item.label || ''); }}>重命名</button><button type="button" className="text-button" disabled={exportingVersion === item.version} onClick={() => exportVersion(item.version)}>{exportingVersion === item.version ? '导出中…' : '导出'}</button></div>}</li>)}</ul> : <p className="student-tool-empty">还没有历史版本，保存画布后会自动生成。</p>}</div></div>}
      </aside>
      <div className="student-canvas-main"><div className="student-canvas-heading"><div><span className="student-kicker">我的课堂画布</span><h2>{project.data.title}</h2></div><span className={`student-save-state ${changed ? 'is-dirty' : ''}`}>{changed ? (autoSaving ? '自动保存中…' : '有未保存修改') : '已保存'}</span></div><div className="student-canvas-viewport"><CanvasEditor key={`${project.data.id}-${canvasVersion}-${canvasRevision}`} initialSnapshot={canvasSnapshot || project.data.canvasSnapshot} capabilities={capabilities} readOnly={!editable} allowNodeCreation={false} showStarter={false} onGenerateNode={generateCanvasNode} onChange={setDraft} /></div></div>
    </section>
    <div className="student-canvas-submitbar"><div><strong>完成作品后记得提交</strong><span>老师会根据你的画布内容进行点评</span></div><div className="student-submit-actions"><button className="secondary-button" onClick={() => navigate('/learn/canvas')}>退出课堂</button><button className="primary-canvas-button student-submit-button" disabled={!editable || busy || !draft || !hasNodes} onClick={submitWork}>{busy ? '提交中…' : '提交作品 ✨'}</button></div></div>
    {message && <div className={`student-canvas-toast ${message.includes('失败') || message.includes('错误') ? 'error' : ''}`}>{message}</div>}
    {promptTarget && <div className="student-slot-picker" role="dialog" aria-modal="true"><div className="student-slot-picker__panel"><strong>把「{promptTarget.material.title}」插入到哪个框体？</strong><div className="student-slot-picker__list">{promptTarget.targets.map((node) => <button key={node.id} type="button" onClick={() => insertPromptToSlot(node.id)}>{node.data?.title || node.type}<small>{node.type === 'video' ? '生视频' : '生图'}{node.data?.aspectRatio ? ' · ' + node.data.aspectRatio : ''}</small></button>)}</div><button type="button" className="secondary-button" onClick={() => setPromptTarget(null)}>取消</button></div></div>}
    {preview && <div className="student-slot-picker" role="dialog" aria-modal="true"><div className="student-slot-picker__panel student-version-preview"><strong>版本 {preview.version} 预览</strong><p className="muted">{preview.label || '未命名版本'} · {formatDate(preview.createdAt)}{preview.actorName ? ' · ' + preview.actorName : ''}</p><div className="student-version-preview__canvas"><CanvasEditor key={`preview-${preview.version}`} initialSnapshot={preview.canvasSnapshot} capabilities={capabilities} readOnly allowNodeCreation={false} showStarter={false} /></div><button type="button" className="secondary-button" onClick={() => setPreview(null)}>关闭预览</button></div></div>}
  </main>;

}

