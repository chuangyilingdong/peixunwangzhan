import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { formatDate } from './auth.js';
import { ErrorState, Loading, Notice, Empty, Panel, PageHeader, Status } from './ui.jsx';

// Signatures and helpers (copied from apps/student/src/main.jsx)
function canvasContentSignature(snapshot) {
  if (!snapshot) return '';
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
  return JSON.stringify({
    nodes: nodes.map((node) => ({ id: node.id, type: node.type, props: node.props || {} })),
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
    if (JSON.stringify(prev.props || {}) !== JSON.stringify(node.props || {})) changed.push(node);
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
  const label = node.props?.label || node.props?.title || node.props?.text || node.props?.name || '';
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

// Embedded useData hook (also exported separately in classroom.jsx)
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

  async function generateMaterial(event) {
    event.preventDefault();
    if (!editable) return;
    setGenerating(true);
    try {
      const queued = await api.post('ai/generations/async', { projectId: project.data.id, ...generationForm });
      let result = queued.job;
      for (let attempt = 0; attempt < 30 && !['SUCCEEDED', 'FAILED'].includes(result.status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        result = await api.get(`ai/generations/history/${encodeURIComponent(result.id)}`);
      }
      if (result.status !== 'SUCCEEDED') throw new Error(result.errorMessage || 'AI 生成失败');
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

  return <>
    <PageHeader eyebrow="魔法画布" title={project.data.title} description={editable ? '把提示词、画面和故事卡片连起来，完成属于你的创作流程。' : '项目已提交，当前以只读方式展示画布内容。'} actions={<><button className="secondary-button" onClick={() => navigate('/projects')}>返回项目</button>{editable && <button className="primary-button" onClick={save} disabled={busy || !draft || !changed}>{busy ? '保存中…' : changed ? '保存画布' : '已保存'}</button>}</>} />
    <div className="row-actions canvas-meta"><Status value={project.data.status} /><span className="muted">关联课时：{project.data.courseLessonTitle || '—'}</span><span className="muted">当前版本：{project.data.latestVersion}</span><span className="muted">{changed ? '画布有未保存修改' : '所有修改已保存'}</span></div>
    {message && <Notice tone={message.includes('已保存') || message.includes('已将') || message.includes('已重命名') || message.includes('已导出') || message.includes('已导入') || message.includes('已生成') ? 'success' : 'danger'}>{message}</Notice>}
    {editable && <Panel title="导入画布快照"><label>选择已导出的 JSON 文件<input type="file" accept="application/json,.json" disabled={importingCanvas} onChange={importCanvas} /></label><Notice>仅支持本平台导出的画布 JSON，最大 1MB。导入只会替换当前未保存草稿；确认后点击“保存画布”才会创建当前项目的新版本。</Notice></Panel>}
    {editable && <Panel title="下一次保存的版本名称"><label>版本名称<input value={saveLabel} maxLength={100} onChange={(event) => setSaveLabel(event.target.value)} placeholder="例如：完成小狐狸分镜" /></label><Notice>保存时会使用这个名称创建一个新版本；不填写时默认标记为“画布编辑”。</Notice></Panel>}
    {editable && <Panel title="AI 素材工坊"><form onSubmit={generateMaterial}><label>素材类型<select value={generationForm.modality} onChange={(event) => setGenerationForm((current) => ({ ...current, modality: event.target.value }))}><option value="IMAGE">画面素材</option><option value="VIDEO">故事短片</option><option value="MUSIC">音乐素材</option><option value="PODCAST">播客素材</option><option value="DUBBING">配音素材</option><option value="TEXT">灵感提示词</option></select></label><label>素材名称（可选）<input value={generationForm.title} maxLength={100} placeholder="例如：星光森林封面" onChange={(event) => setGenerationForm((current) => ({ ...current, title: event.target.value }))} /></label><label>描述你的素材<textarea value={generationForm.prompt} required maxLength={2000} placeholder="例如：夜晚的星光森林里，小狐狸举着发光的种子。" onChange={(event) => setGenerationForm((current) => ({ ...current, prompt: event.target.value }))} /></label><button className="primary-button" disabled={generating}>{generating ? '生成中…' : '生成并加入画布（1 积分）'}</button></form><Notice tone="warning">当前供应商：{generations.data?.provider?.provider || 'local-mock'}。真实供应商 adapter 当前支持 TEXT、IMAGE、MUSIC、VIDEO、PODCAST、DUBBING 六类调用；若平台尚未配置真实 provider、对应 Endpoint 或服务器密钥，系统会明确提示，不会伪造成功。</Notice>{generations.data?.items?.length ? <div className="card-list">{generations.data.items.slice(0, 3).map((job) => <article className="item-card" key={job.id}><div className="row-actions"><strong>{job.modality} · {job.prompt.slice(0, 40)}</strong><Status value={job.status === 'SUCCEEDED' ? 'APPROVED' : job.status === 'FAILED' ? 'REJECTED' : 'PENDING'} /></div>{job.assets?.[0] && <AssetPreview asset={job.assets[0]} />}<p className="muted">{job.provider} · {formatDate(job.createdAt)} · {job.creditsCharged} 积分</p></article>)}</div> : null}</Panel>}
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

