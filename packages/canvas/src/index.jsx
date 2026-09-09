import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';

const CanvasActionsContext = createContext(null);
const EMPTY_VIEWPORT = { x: 0, y: 0, zoom: 1 };

function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function safeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return { nodes: [], edges: [], viewport: EMPTY_VIEWPORT };
  return {
    nodes: Array.isArray(snapshot.nodes) ? snapshot.nodes : [],
    edges: Array.isArray(snapshot.edges) ? snapshot.edges : [],
    viewport: { ...EMPTY_VIEWPORT, ...(snapshot.viewport || {}) },
  };
}

export const CANVAS_TEMPLATE_OPTIONS = [
  { id: 'adventure', label: '角色冒险', description: '角色在奇幻场景中完成一个小任务。' },
  { id: 'science', label: '科学小实验', description: '用角色、场景和步骤讲清一个科学发现。' },
];

export function createCanvasTemplate(templateId = 'adventure') {
  const characterId = id('character');
  const sceneId = id('scene');
  const promptId = id('prompt');
  const imageId = id('image');
  const videoId = id('video');
  const edge = (source, target) => ({ id: id('edge'), source, target, markerEnd: { type: MarkerType.ArrowClosed }, animated: true });

  if (templateId === 'science') {
    return {
      nodes: [
        { id: characterId, type: 'character', position: { x: 80, y: 80 }, data: { title: '小小科学家', emoji: '🧑‍🔬', name: '泡泡博士', trait: '爱观察，也爱提问题' } },
        { id: sceneId, type: 'scene', position: { x: 80, y: 340 }, data: { title: '实验场景', emoji: '🔬', place: '明亮的小实验室', mood: '好奇又专注' } },
        { id: promptId, type: 'prompt', position: { x: 430, y: 150 }, data: { title: '实验问题', text: '为什么有些东西会浮在水面上，有些会沉下去？' } },
        { id: imageId, type: 'image', position: { x: 780, y: 70 }, data: { title: '观察画面', emoji: '🫧', caption: '水杯里的漂浮小实验' } },
        { id: videoId, type: 'video', position: { x: 780, y: 340 }, data: { title: '实验讲解', text: '泡泡博士把不同材料放进水里，记录它们的变化。' } },
      ],
      edges: [edge(characterId, promptId), edge(sceneId, promptId), edge(promptId, imageId), edge(promptId, videoId)],
      viewport: { x: 10, y: 25, zoom: 0.7 },
    };
  }

  return {
    nodes: [
      { id: characterId, type: 'character', position: { x: 80, y: 80 }, data: { title: '故事角色', emoji: '🦊', name: '露娜小狐狸', trait: '勇敢、善良，喜欢帮助朋友' } },
      { id: sceneId, type: 'scene', position: { x: 80, y: 340 }, data: { title: '故事场景', emoji: '🌲', place: '会发光的星光森林', mood: '神秘又温暖' } },
      { id: promptId, type: 'prompt', position: { x: 430, y: 150 }, data: { title: '魔法提示词', text: '露娜小狐狸在星光森林里寻找一颗能帮助朋友的发光种子。' } },
      { id: imageId, type: 'image', position: { x: 780, y: 70 }, data: { title: '画面灵感', emoji: '🌟', caption: '被星光照亮的森林小路' } },
      { id: videoId, type: 'video', position: { x: 780, y: 340 }, data: { title: '故事短片', text: '露娜找到种子，并把光带回森林里的朋友身边。' } },
    ],
    edges: [edge(characterId, promptId), edge(sceneId, promptId), edge(promptId, imageId), edge(promptId, videoId)],
    viewport: { x: 10, y: 25, zoom: 0.7 },
  };
}

export function autoLayoutSnapshot(snapshot) {
  const current = safeSnapshot(snapshot);
  const nodeMap = new Map(current.nodes.map((node) => [node.id, node]));
  const incoming = new Map(current.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(current.nodes.map((node) => [node.id, []]));
  current.edges.forEach((edge) => {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) return;
    outgoing.get(edge.source).push(edge.target);
    incoming.set(edge.target, (incoming.get(edge.target) || 0) + 1);
  });
  const depth = new Map();
  const queue = current.nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  queue.forEach((nodeId) => depth.set(nodeId, 0));
  while (queue.length) {
    const source = queue.shift();
    const sourceDepth = depth.get(source) || 0;
    outgoing.get(source).forEach((target) => {
      depth.set(target, Math.max(depth.get(target) || 0, sourceDepth + 1));
      incoming.set(target, (incoming.get(target) || 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    });
  }
  current.nodes.forEach((node, index) => { if (!depth.has(node.id)) depth.set(node.id, index % 3); });
  const rowsByDepth = new Map();
  const positions = new Map();
  current.nodes.forEach((node) => {
    const column = depth.get(node.id) || 0;
    const row = rowsByDepth.get(column) || 0;
    rowsByDepth.set(column, row + 1);
    positions.set(node.id, { x: 90 + column * 320, y: 110 + row * 245 });
  });
  return { nodes: current.nodes.map((node) => ({ ...node, position: positions.get(node.id) })), edges: current.edges, viewport: { x: 0, y: 0, zoom: 0.72 } };
}

export function createStarterSnapshot() {
  const promptId = id('prompt');
  const imageId = id('image');
  const videoId = id('video');
  return {
    nodes: [
      { id: promptId, type: 'prompt', position: { x: 80, y: 190 }, data: { title: '魔法提示词', text: '一只勇敢的小狐狸在星光森林里寻找会发光的种子。' } },
      { id: imageId, type: 'image', position: { x: 430, y: 90 }, data: { title: '画面灵感', emoji: '🦊', caption: '星光森林里的小狐狸' } },
      { id: videoId, type: 'video', position: { x: 780, y: 230 }, data: { title: '故事短片', text: '小狐狸找到了会发光的种子' } },
    ],
    edges: [
      { id: id('edge'), source: promptId, target: imageId, markerEnd: { type: MarkerType.ArrowClosed }, animated: true },
      { id: id('edge'), source: imageId, target: videoId, markerEnd: { type: MarkerType.ArrowClosed }, animated: true },
    ],
    viewport: { x: 15, y: 65, zoom: 0.8 },
  };
}

function useCanvasActions() {
  const actions = useContext(CanvasActionsContext);
  if (!actions) throw new Error('Canvas node must be rendered inside CanvasEditor');
  return actions;
}

function NodeFrame({ icon, tone, title, children, selected, minWidth = 220, minHeight = 140 }) {
  const actions = useContext(CanvasActionsContext);
  const readOnly = Boolean(actions?.readOnly);
  return <div className={`learning-node learning-node--${tone}`}>
    <NodeResizer isVisible={Boolean(selected) && !readOnly} minWidth={minWidth} minHeight={minHeight} lineClassName="learning-node__resize-line" handleClassName="learning-node__resize-handle" />
    <Handle type="target" position={Position.Left} className="learning-node__handle" />
    <div className="learning-node__heading"><span>{icon}</span><strong>{title}</strong></div>
    {children}
    <Handle type="source" position={Position.Right} className="learning-node__handle" />
  </div>;
}

function PromptNode({ id, data, selected }) {
  const { updateNode, generateNode, canGenerate } = useCanvasActions();
  const generated = String(data.generatedText || '');
  return <NodeFrame icon="✎" tone="prompt" title={data.title || '魔法提示词'} selected={selected}>
    <textarea className="learning-node__textarea nodrag" value={data.text || ''} placeholder={data.slotType === 'text' ? '写下你想让 AI 生成什么…' : '写下你的故事或画面描述…'} maxLength={300} onChange={(event) => updateNode(id, { text: event.target.value })} />
    <span className="learning-node__count">{(data.text || '').length}/300</span>
    <SlotParams data={data} />
    {canGenerate && data.slotType === 'text' && (!data.generationStatus || data.generationStatus === 'FAILED') && !generated && <button className="learning-node__generate nodrag" type="button" onClick={() => generateNode(id, 'TEXT', { title: data.title || 'AI 文字', prompt: data.text || '' })}>✎ 生成文字</button>}
    {data.generationStatus && <span className={`learning-node__generation-state ${data.generationStatus === 'FAILED' ? 'is-error' : ''}`}>{data.generationStatus === 'FAILED' ? (data.generationError || '生成失败') : 'AI生成中…'}</span>}
    {generated ? <div className="learning-node__text-result nodrag">{generated}</div> : null}
    {selected && <span className="learning-node__hint">写下提示词后点「生成文字」，AI 帮你写；也可以直接手动编辑。</span>}
  </NodeFrame>;
}

function SlotParams({ data }) {
  if (!data.slotType) return null;
  const params = [];
  if (data.aspectRatio) params.push(data.aspectRatio);
  const quality = data.resolution || data.size;
  if (quality) params.push(quality);
  if (data.durationSeconds) params.push(`${data.durationSeconds}秒`);
  if (data.audio) params.push('含音频');
  if (data.model) params.push(data.model);
  if (!params.length) return null;
  return <span className="learning-node__slot-params">{params.join(' · ')}</span>;
}

function ImageNode({ id, data, selected }) {
  const { updateNode, generateNode, canGenerate, openPreview } = useCanvasActions();
  const imageUrl = data.previewUrl || data.assetUrl;
  // 框体预置素材：老师为这个框体上传的参考图，生成前先给学生看。
  const referenceUrl = !imageUrl ? String(data.referenceUrl || '') : '';
  return <NodeFrame icon="✦" tone="image" title={data.title || '画面灵感'} selected={selected}>
    {imageUrl
      ? <img className="learning-node__media learning-node__media--zoomable nodrag" src={imageUrl} alt={data.caption || 'AI生成画面'} onClick={() => openPreview(imageUrl)} title="点击放大查看" />
      : referenceUrl
        ? <figure className="learning-node__reference nodrag"><img src={referenceUrl} alt="框体预置素材" title="点击放大查看" onClick={() => openPreview(referenceUrl)} /><figcaption>框体预置素材</figcaption></figure>
        : <div className="learning-node__art">{data.emoji || '🌈'}</div>}
    <textarea className="learning-node__textarea learning-node__textarea--compact nodrag" value={data.caption || ''} placeholder="写下画面描述 / 提示词…" maxLength={300} onChange={(event) => updateNode(id, { caption: event.target.value })} />
    <input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="画面表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />
    <SlotParams data={data} />
    {canGenerate && (!data.generationStatus || data.generationStatus === 'FAILED') && !imageUrl && <button className="learning-node__generate nodrag" type="button" onClick={() => generateNode(id, 'IMAGE', { title: data.title || '画面灵感', prompt: data.caption || '' })}>✦ 生成画面</button>}
    {data.generationStatus && <span className={`learning-node__generation-state ${data.generationStatus === 'FAILED' ? 'is-error' : ''}`}>{data.generationStatus === 'FAILED' ? (data.generationError || '生成失败') : 'AI生成中…'}</span>}
    {selected && <span className="learning-node__hint">用描述生成画面，也可以继续编辑灵感</span>}
  </NodeFrame>;
}
function CharacterNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="♙" tone="character" title={data.title || '故事角色'} selected={selected}>
    <div className="learning-node__character-art">{data.emoji || '🧒'}</div>
    <input className="learning-node__input nodrag" value={data.name || ''} placeholder="角色名字" maxLength={40} onChange={(event) => updateNode(id, { name: event.target.value })} />
    <input className="learning-node__input learning-node__input--compact nodrag" value={data.trait || ''} placeholder="性格、能力或目标" maxLength={80} onChange={(event) => updateNode(id, { trait: event.target.value })} />
    <input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="角色表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />
    {selected && <span className="learning-node__hint">先介绍角色，再把它连接到场景和故事片段</span>}
  </NodeFrame>;
}

function SceneNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="⌂" tone="scene" title={data.title || '故事场景'} selected={selected}>
    <div className="learning-node__scene-art"><span>{data.emoji || '🌲'}</span><small>{data.mood || '神秘氛围'}</small></div>
    <input className="learning-node__input nodrag" value={data.place || ''} placeholder="场景地点" maxLength={60} onChange={(event) => updateNode(id, { place: event.target.value })} />
    <input className="learning-node__input learning-node__input--compact nodrag" value={data.mood || ''} placeholder="氛围，例如：温暖、紧张" maxLength={80} onChange={(event) => updateNode(id, { mood: event.target.value })} />
    <input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="场景表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />
    {selected && <span className="learning-node__hint">记录故事发生的地点和氛围，让画面更完整</span>}
  </NodeFrame>;
}

function VideoNode({ id, data, selected }) {
  const { updateNode, generateNode, canGenerate, getIncomingImageAssetUrl } = useCanvasActions();
  const videoUrl = data.previewUrl || data.assetUrl;
  // 图生视频模型（i2v）需要首帧图：优先用连过来的图片，其次用框体预置素材。
  const requiresFirstFrame = data.slotType === 'video' && data.requiresFirstFrame === true;
  const referenceUrl = !videoUrl ? String(data.referenceUrl || '') : '';
  const sourceAssetUrl = requiresFirstFrame ? (getIncomingImageAssetUrl(id) || referenceUrl) : '';
  const missingFirstFrame = requiresFirstFrame && !sourceAssetUrl;
  return <NodeFrame icon="▶" tone="video" title={data.title || '故事短片'} selected={selected}>
    {videoUrl
      ? <video className="learning-node__media" controls playsInline src={videoUrl} />
      : referenceUrl
        ? <figure className="learning-node__reference nodrag"><img src={referenceUrl} alt="框体预置首帧" /><figcaption>框体预置首帧</figcaption></figure>
        : <div className="learning-node__video-preview"><span>▶</span><small>作品片段</small></div>}
    <textarea className="learning-node__textarea learning-node__textarea--compact nodrag" value={data.text || ''} placeholder="写下这一段的提示词…" maxLength={300} onChange={(event) => updateNode(id, { text: event.target.value })} />
    <SlotParams data={data} />
    {canGenerate && (!data.generationStatus || data.generationStatus === 'FAILED') && !videoUrl && <button className="learning-node__generate nodrag" type="button" disabled={missingFirstFrame} title={missingFirstFrame ? '该模型需要先连接一张画面（首帧）' : undefined} onClick={() => generateNode(id, 'VIDEO', { title: data.title || '故事短片', prompt: data.text || '', sourceAssetUrl })}>▶ 生成故事短片</button>}
    {missingFirstFrame && !data.generationStatus && <span className="learning-node__generation-state is-error">该模型需要先连接一张画面（首帧）</span>}
    {data.generationStatus && <span className={`learning-node__generation-state ${data.generationStatus === 'FAILED' ? 'is-error' : ''}`}>{data.generationStatus === 'FAILED' ? (data.generationError || '生成失败') : 'AI生成中…'}</span>}
    {selected && <span className="learning-node__hint">{missingFirstFrame ? '从图片节点的圆点连到本卡片，才能生成' : '连接提示词或画面，组织故事顺序'}</span>}
  </NodeFrame>;
}

function NoteNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="☼" tone="note" title={data.title || '创作便签'} selected={selected}>
    <textarea className="learning-node__textarea nodrag" value={data.text || ''} placeholder="记录一个创作想法…" maxLength={300} onChange={(event) => updateNode(id, { text: event.target.value })} />
    {selected && <span className="learning-node__hint">便签可以保存你的灵感</span>}
  </NodeFrame>;
}

// 音频节点按本课开放的音频能力提供生成入口（音乐 / 播客 / 配音）。
const AUDIO_MODALITIES = [['MUSIC', '生成音乐'], ['PODCAST', '生成播客'], ['DUBBING', '生成配音']];

function AudioNode({ id, data, selected }) {
  const { updateNode, generateNode, canGenerate, enabledCapabilities } = useCanvasActions();
  const audioUrl = data.previewUrl || data.assetUrl;
  const available = AUDIO_MODALITIES.filter(([modality]) => enabledCapabilities?.has(modality.toLowerCase()));
  return <NodeFrame icon="♫" tone="audio" title={data.title || '音频素材'} selected={selected}>
    {audioUrl ? <audio className="learning-node__audio" controls src={audioUrl} /> : <div className="learning-node__audio-placeholder">♫ 音频素材</div>}
    <input className="learning-node__input nodrag" value={data.text || data.caption || ''} placeholder="音频说明 / 提示词" maxLength={180} onChange={(event) => updateNode(id, { text: event.target.value, caption: event.target.value })} />
    {canGenerate && available.length && !data.generationStatus ? <div className="learning-node__generate-row">{available.map(([modality, label]) => <button key={modality} className="learning-node__generate nodrag" type="button" onClick={() => generateNode(id, modality, { title: data.title || '音频素材', prompt: data.text || data.caption || '' })}>{audioUrl ? `重新${label}` : label}</button>)}</div> : null}
    {data.generationStatus && <span className={`learning-node__generation-state ${data.generationStatus === 'FAILED' ? 'is-error' : ''}`}>{data.generationStatus === 'FAILED' ? (data.generationError || '生成失败') : 'AI生成中…'}</span>}
    {selected && <span className="learning-node__hint">可播放课程音频、音乐或配音素材；本课开放哪几种音频能力，就出现哪几个生成按钮</span>}
  </NodeFrame>;
}

function AnimationNode({ id, data, selected }) {
  const { updateNode, generateNode, canGenerate, enabledCapabilities } = useCanvasActions();
  const videoUrl = data.previewUrl || data.assetUrl;
  return <NodeFrame icon="✧" tone="animation" title={data.title || '动画素材'} selected={selected}>
    {videoUrl ? <video className="learning-node__media" controls muted loop src={videoUrl} /> : <div className="learning-node__animation-placeholder">✧ 动画素材</div>}
    <input className="learning-node__input nodrag" value={data.text || data.caption || ''} placeholder="动画说明 / 提示词" maxLength={180} onChange={(event) => updateNode(id, { text: event.target.value, caption: event.target.value })} />
    {canGenerate && enabledCapabilities?.has('video') && !data.generationStatus && <button className="learning-node__generate nodrag" type="button" onClick={() => generateNode(id, 'VIDEO', { title: data.title || '动画素材', prompt: data.text || data.caption || '' })}>✧ {videoUrl ? '重新生成动画' : '生成动画'}</button>}
    {data.generationStatus && <span className={`learning-node__generation-state ${data.generationStatus === 'FAILED' ? 'is-error' : ''}`}>{data.generationStatus === 'FAILED' ? (data.generationError || '生成失败') : 'AI生成中…'}</span>}
    {selected && <span className="learning-node__hint">动画按视频能力生成；本课未开放 AI 生视频时不能生成</span>}
  </NodeFrame>;
}

const nodeTypes = { prompt: PromptNode, image: ImageNode, character: CharacterNode, scene: SceneNode, video: VideoNode, note: NoteNode, audio: AudioNode, animation: AnimationNode };

function CanvasSurface({ initialSnapshot, readOnly, onChange, onGenerateNode, showStarter, capabilities = ['text'], allowNodeCreation = true }) {
  // 受控课堂画布（allowNodeCreation=false）默认不使用固定起始底稿，避免空画布每次刷新被自动填充。
  const shouldShowStarter = showStarter === undefined ? (!readOnly && allowNodeCreation) : showStarter;
  const initial = useMemo(() => {
    const restored = safeSnapshot(initialSnapshot);
    return restored.nodes.length || !shouldShowStarter ? restored : createStarterSnapshot();
  }, [initialSnapshot, shouldShowStarter]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [viewport, setViewport] = useState(initial.viewport);
  const [contextMenu, setContextMenu] = useState(null);
  const [previewImage, setPreviewImage] = useState(null);
  const { getViewport, screenToFlowPosition } = useReactFlow();
  const enabledCapabilities = useMemo(() => new Set(Array.isArray(capabilities) && capabilities.length ? capabilities : ['text']), [capabilities]);
  const historyRef = useRef({ past: [], future: [] });
  const clipboardRef = useRef([]);
  const restoringHistoryRef = useRef(false);

  const pushHistory = useCallback((snapshot) => {
    if (readOnly || restoringHistoryRef.current) return;
    historyRef.current = { past: [...historyRef.current.past.slice(-49), safeSnapshot(snapshot)], future: [] };
  }, [readOnly]);

  const updateNode = useCallback((nodeId, changes) => {
    if (readOnly) return;
    pushHistory({ nodes, edges, viewport });
    setNodes((current) => current.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, ...changes } } : node));
  }, [edges, nodes, pushHistory, readOnly, setNodes, viewport]);

  const generateNode = useCallback(async (nodeId, modality, input) => {
    if (readOnly || !onGenerateNode) return;
    updateNode(nodeId, { generationStatus: 'PENDING', generationError: '' });
    try {
      // 生成框体：把框体 id 一起提交，服务端据此取该框体自己的模型与参数，并保证每个框体只生成一次。
      const boxId = (nodes || []).find((node) => node.id === nodeId)?.data?.boxId || '';
      const asset = await onGenerateNode({ nodeId, modality, boxId, ...input });
      if (String(modality).toUpperCase() === 'TEXT') {
        // 文字结果写进 generatedText，保留学生自己写的提示词
        updateNode(nodeId, { generatedText: String(asset?.metadata?.text || asset?.text || ''), generationStatus: null, generationError: '' });
      } else {
        updateNode(nodeId, { assetUrl: asset.assetUrl, previewUrl: asset.previewUrl, generationStatus: null, generationError: '' });
      }
    } catch (error) {
      updateNode(nodeId, { generationStatus: 'FAILED', generationError: error instanceof Error ? error.message : 'AI生成失败' });
    }
  }, [nodes, onGenerateNode, readOnly, updateNode]);

  // 取连到该节点的图片素材地址，供图生视频当首帧。
  const getIncomingImageAssetUrl = useCallback((nodeId) => {
    const sourceIds = new Set((edges || []).filter((edge) => edge.target === nodeId).map((edge) => edge.source));
    const imageNode = (nodes || []).find((node) => sourceIds.has(node.id) && node.type === 'image');
    return String(imageNode?.data?.assetUrl || imageNode?.data?.previewUrl || '');
  }, [edges, nodes]);
  const addNodeAt = useCallback((type, position) => {
    if (readOnly || !allowNodeCreation) return;
    const capabilityByType = { prompt: 'text', image: 'image', video: 'video' };
    const requiredCapability = capabilityByType[type];
    const audioEnabled = ['music', 'podcast', 'dubbing'].some((key) => enabledCapabilities.has(key));
    if ((requiredCapability && !enabledCapabilities.has(requiredCapability)) || (type === 'audio' && !audioEnabled)) return;
    const templates = {
      prompt: { title: 'AI 文字提示词', text: '' },
      image: { title: 'AI 生图', emoji: '✨', caption: '' },
      video: { title: 'AI 生视频', text: '' },
      audio: { title: 'AI 音频', text: '' },
      character: { title: '故事角色', emoji: '🧒', name: '', trait: '' },
      scene: { title: '故事场景', emoji: '🌲', place: '', mood: '' },
    };
    pushHistory({ nodes, edges, viewport });
    setNodes((current) => [...current, { id: id(type), type, position, data: templates[type] || { title: '画布节点', text: '' } }]);
    setContextMenu(null);
  }, [edges, enabledCapabilities, nodes, pushHistory, readOnly, allowNodeCreation, setNodes, viewport]);

  const handlePaneContextMenu = useCallback((event) => {
    if (readOnly || !allowNodeCreation) return;
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, position: screenToFlowPosition({ x: event.clientX, y: event.clientY }) });
  }, [readOnly, allowNodeCreation, screenToFlowPosition]);

  const onConnect = useCallback((connection) => {
    if (readOnly) return;
    pushHistory({ nodes, edges, viewport });
    setEdges((current) => addEdge({ ...connection, id: id('edge'), markerEnd: { type: MarkerType.ArrowClosed }, animated: true }, current));
  }, [edges, nodes, pushHistory, readOnly, setEdges, viewport]);

  const onDrop = useCallback((event) => {
    event.preventDefault();
    if (readOnly || !allowNodeCreation) return;
    const raw = event.dataTransfer.getData('application/x-learning-material');
    if (!raw) return;
    let material;
    try { material = JSON.parse(raw); } catch { return; }
    const snapshot = material?.snapshot && typeof material.snapshot === 'object' ? material.snapshot : {};
    const sourceData = snapshot.data || snapshot.props || {};
    const materialType = String(material?.materialType || snapshot.type || 'NOTE').toUpperCase();
    const type = snapshot.type || ({ IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', MUSIC: 'audio', PODCAST: 'audio', DUBBING: 'audio', ANIMATION: 'animation', CHARACTER: 'character', SCENE: 'scene', TEXT: 'prompt', PROMPT: 'prompt' }[materialType] || 'note');
    const fallbackData = type === 'image' ? { title: material.title, emoji: '✨', caption: material.description || '' } : type === 'video' ? { title: material.title, text: material.description || '' } : type === 'audio' ? { title: material.title, text: material.description || '', assetUrl: material.assetUrl, previewUrl: material.previewUrl } : type === 'animation' ? { title: material.title, text: material.description || '', assetUrl: material.assetUrl, previewUrl: material.previewUrl } : type === 'character' ? { title: material.title, emoji: '🧒', name: '', trait: material.description || '' } : type === 'scene' ? { title: material.title, emoji: '🌲', place: material.description || '', mood: '' } : { title: material.title, text: material.description || '' };
    pushHistory({ nodes, edges, viewport });
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = screenToFlowPosition({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    setNodes((current) => [...current, { id: `material-${Date.now().toString(36)}`, type, position, data: { ...fallbackData, ...sourceData, title: material.title || sourceData.title, lessonMaterialId: material.id, isLessonMaterial: true } }]);
  }, [edges, nodes, pushHistory, readOnly, allowNodeCreation, screenToFlowPosition, setNodes, viewport]);

  const handleNodesChange = useCallback((changes) => {
    if (!readOnly && changes.some((change) => change.type !== 'select')) pushHistory({ nodes, edges, viewport });
    onNodesChange(changes);
  }, [edges, nodes, onNodesChange, pushHistory, readOnly, viewport]);

  const handleEdgesChange = useCallback((changes) => {
    if (!readOnly && changes.some((change) => change.type !== 'select')) pushHistory({ nodes, edges, viewport });
    onEdgesChange(changes);
  }, [edges, nodes, onEdgesChange, pushHistory, readOnly, viewport]);

  const undo = useCallback(() => {
    const past = historyRef.current.past;
    if (readOnly || !past.length) return;
    const previous = past[past.length - 1];
    historyRef.current = { past: past.slice(0, -1), future: [safeSnapshot({ nodes, edges, viewport }), ...historyRef.current.future].slice(0, 50) };
    restoringHistoryRef.current = true;
    setNodes(previous.nodes); setEdges(previous.edges); setViewport(previous.viewport);
    window.setTimeout(() => { restoringHistoryRef.current = false; }, 0);
  }, [edges, nodes, readOnly, setEdges, setNodes, viewport]);

  const redo = useCallback(() => {
    const future = historyRef.current.future;
    if (readOnly || !future.length) return;
    const next = future[0];
    historyRef.current = { past: [...historyRef.current.past, safeSnapshot({ nodes, edges, viewport })].slice(-50), future: future.slice(1) };
    restoringHistoryRef.current = true;
    setNodes(next.nodes); setEdges(next.edges); setViewport(next.viewport);
    window.setTimeout(() => { restoringHistoryRef.current = false; }, 0);
  }, [edges, nodes, readOnly, setEdges, setNodes, viewport]);

  useEffect(() => {
    if (readOnly) return undefined;
    const handleKeyDown = (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        const selected = nodes.filter((node) => node.selected);
        if (selected.length) { clipboardRef.current = selected.map((node) => ({ ...node, selected: false, data: { ...node.data } })); event.preventDefault(); }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v' && clipboardRef.current.length) {
        event.preventDefault(); pushHistory({ nodes, edges, viewport });
        const pasted = clipboardRef.current.map((node, index) => ({ ...node, id: id(node.type), position: { x: node.position.x + 40 + index * 18, y: node.position.y + 40 + index * 18 }, selected: false, data: { ...node.data } }));
        setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), ...pasted]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [edges, nodes, pushHistory, readOnly, redo, setNodes, undo, viewport]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', close); };
  }, [contextMenu]);

  useEffect(() => {
    onChange?.({ nodes, edges, viewport: getViewport() });
  }, [edges, getViewport, nodes, onChange, viewport]);

  return <CanvasActionsContext.Provider value={{ updateNode, generateNode, canGenerate: Boolean(onGenerateNode), openPreview: setPreviewImage, readOnly, enabledCapabilities, getIncomingImageAssetUrl }}>
    <div className="learning-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={readOnly ? undefined : handleNodesChange}
        onEdgesChange={readOnly ? undefined : handleEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onPaneContextMenu={handlePaneContextMenu}
        onPaneClick={() => setContextMenu(null)}
        onDragOver={(event) => event.preventDefault()}
        onMoveEnd={() => setViewport(getViewport())}
        fitView
        fitViewOptions={{ padding: 0.22 }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        // 框体是课时配额的生成入口，删掉后素材面板无法补回，所以禁止删除框体；其他节点照常可删。
        onBeforeDelete={readOnly ? undefined : async ({ nodes: deletingNodes, edges: deletingEdges }) => {
          const protectedIds = new Set((deletingNodes || []).filter((node) => node.data?.slotType).map((node) => node.id));
          if (!protectedIds.size) return true;
          return {
            nodes: (deletingNodes || []).filter((node) => !protectedIds.has(node.id)),
            edges: (deletingEdges || []).filter((edge) => !protectedIds.has(edge.source) && !protectedIds.has(edge.target)),
          };
        }}
        minZoom={0.35}
        maxZoom={1.8}
        defaultViewport={initial.viewport}
      >
        <Background color="#7e8ed8" gap={24} size={1} />
        <MiniMap pannable zoomable className="learning-canvas__minimap" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="learning-canvas__tip">{allowNodeCreation ? '拖动卡片、从圆点连线；右键空白处可创建节点。' : '从左侧「素材」面板添加框体与素材，拖动卡片、从圆点连线。一个框体只能生成一次，框体加入画布后不能删除。'}</div>
      {previewImage && <div className="learning-canvas__lightbox" role="dialog" aria-modal="true" onClick={() => setPreviewImage(null)}><img src={previewImage} alt="素材预览" onClick={(event) => event.stopPropagation()} /><button type="button" className="learning-canvas__lightbox-close" onClick={() => setPreviewImage(null)}>×</button></div>}
      {contextMenu && allowNodeCreation && <div className="learning-canvas__context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
        <strong>创建节点</strong>
        <button type="button" onClick={() => addNodeAt('prompt', contextMenu.position)} disabled={!enabledCapabilities.has('text')}>✎ AI 文字</button>
        <button type="button" onClick={() => addNodeAt('image', contextMenu.position)} disabled={!enabledCapabilities.has('image')}>✦ AI 生图{!enabledCapabilities.has('image') && <small>本课未开放</small>}</button>
        <button type="button" onClick={() => addNodeAt('video', contextMenu.position)} disabled={!enabledCapabilities.has('video')}>▶ AI 生视频{!enabledCapabilities.has('video') && <small>本课未开放</small>}</button>
        <button type="button" onClick={() => addNodeAt('audio', contextMenu.position)} disabled={!(['music', 'podcast', 'dubbing'].some((key) => enabledCapabilities.has(key)))}>♫ AI 音频{!(['music', 'podcast', 'dubbing'].some((key) => enabledCapabilities.has(key))) && <small>本课未开放</small>}</button>
        <button type="button" onClick={() => addNodeAt('character', contextMenu.position)}>♙ 角色节点</button>
        <button type="button" onClick={() => addNodeAt('scene', contextMenu.position)}>⌂ 场景节点</button>
      </div>}
    </div>
  </CanvasActionsContext.Provider>;
}

export function CanvasEditor(props) {
  return <ReactFlowProvider><CanvasSurface {...props} /></ReactFlowProvider>;
}
