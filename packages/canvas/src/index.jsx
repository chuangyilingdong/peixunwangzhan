import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
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

function NodeFrame({ icon, tone, title, children }) {
  return <div className={`learning-node learning-node--${tone}`}>
    <Handle type="target" position={Position.Left} className="learning-node__handle" />
    <div className="learning-node__heading"><span>{icon}</span><strong>{title}</strong></div>
    {children}
    <Handle type="source" position={Position.Right} className="learning-node__handle" />
  </div>;
}

function PromptNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="✎" tone="prompt" title={data.title || '魔法提示词'}>
    <textarea className="learning-node__textarea nodrag" value={data.text || ''} placeholder="写下你的故事或画面描述…" maxLength={300} onChange={(event) => updateNode(id, { text: event.target.value })} />
    <span className="learning-node__count">{(data.text || '').length}/300</span>
    {selected && <span className="learning-node__hint">可以拖动卡片或从两侧圆点连线</span>}
  </NodeFrame>;
}

function ImageNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="✦" tone="image" title={data.title || '画面灵感'}>
    <div className="learning-node__art">{data.emoji || '🌈'}</div>
    <input className="learning-node__input nodrag" value={data.caption || ''} placeholder="给画面取个名字" onChange={(event) => updateNode(id, { caption: event.target.value })} />
    <input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="画面表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />
    {selected && <span className="learning-node__hint">用表情和一句话记录画面灵感</span>}
  </NodeFrame>;
}

function CharacterNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="♙" tone="character" title={data.title || '故事角色'}>
    <div className="learning-node__character-art">{data.emoji || '🧒'}</div>
    <input className="learning-node__input nodrag" value={data.name || ''} placeholder="角色名字" maxLength={40} onChange={(event) => updateNode(id, { name: event.target.value })} />
    <input className="learning-node__input learning-node__input--compact nodrag" value={data.trait || ''} placeholder="性格、能力或目标" maxLength={80} onChange={(event) => updateNode(id, { trait: event.target.value })} />
    <input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="角色表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />
    {selected && <span className="learning-node__hint">先介绍角色，再把它连接到场景和故事片段</span>}
  </NodeFrame>;
}

function SceneNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="⌂" tone="scene" title={data.title || '故事场景'}>
    <div className="learning-node__scene-art"><span>{data.emoji || '🌲'}</span><small>{data.mood || '神秘氛围'}</small></div>
    <input className="learning-node__input nodrag" value={data.place || ''} placeholder="场景地点" maxLength={60} onChange={(event) => updateNode(id, { place: event.target.value })} />
    <input className="learning-node__input learning-node__input--compact nodrag" value={data.mood || ''} placeholder="氛围，例如：温暖、紧张" maxLength={80} onChange={(event) => updateNode(id, { mood: event.target.value })} />
    <input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="场景表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />
    {selected && <span className="learning-node__hint">记录故事发生的地点和氛围，让画面更完整</span>}
  </NodeFrame>;
}

function VideoNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="▶" tone="video" title={data.title || '故事短片'}>
    <div className="learning-node__video-preview"><span>▶</span><small>作品片段</small></div>
    <input className="learning-node__input nodrag" value={data.text || ''} placeholder="这一段发生了什么？" onChange={(event) => updateNode(id, { text: event.target.value })} />
    {selected && <span className="learning-node__hint">连接提示词或画面，组织故事顺序</span>}
  </NodeFrame>;
}

function NoteNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="☼" tone="note" title={data.title || '创作便签'}>
    <textarea className="learning-node__textarea nodrag" value={data.text || ''} placeholder="记录一个创作想法…" maxLength={300} onChange={(event) => updateNode(id, { text: event.target.value })} />
    {selected && <span className="learning-node__hint">便签可以保存你的灵感</span>}
  </NodeFrame>;
}

function AudioNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="♫" tone="audio" title={data.title || '音频素材'}>
    {data.assetUrl || data.previewUrl ? <audio className="learning-node__audio" controls src={data.previewUrl || data.assetUrl} /> : <div className="learning-node__audio-placeholder">♫ 音频素材</div>}
    <input className="learning-node__input nodrag" value={data.text || data.caption || ''} placeholder="音频说明" maxLength={180} onChange={(event) => updateNode(id, { text: event.target.value, caption: event.target.value })} />
    {selected && <span className="learning-node__hint">可播放课程音频、音乐或配音素材</span>}
  </NodeFrame>;
}

function AnimationNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="✧" tone="animation" title={data.title || '动画素材'}>
    {data.previewUrl || data.assetUrl ? <video className="learning-node__media" controls muted loop src={data.previewUrl || data.assetUrl} /> : <div className="learning-node__animation-placeholder">✧ 动画素材</div>}
    <input className="learning-node__input nodrag" value={data.text || data.caption || ''} placeholder="动画说明" maxLength={180} onChange={(event) => updateNode(id, { text: event.target.value, caption: event.target.value })} />
    {selected && <span className="learning-node__hint">用于展示动态画面或动画生成结果</span>}
  </NodeFrame>;
}

const nodeTypes = { prompt: PromptNode, image: ImageNode, character: CharacterNode, scene: SceneNode, video: VideoNode, note: NoteNode, audio: AudioNode, animation: AnimationNode };

function CanvasSurface({ initialSnapshot, readOnly, onChange, showStarter = !readOnly, capabilities = ['text'] }) {
  const initial = useMemo(() => {
    const restored = safeSnapshot(initialSnapshot);
    return restored.nodes.length || !showStarter ? restored : createStarterSnapshot();
  }, [initialSnapshot]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [viewport, setViewport] = useState(initial.viewport);
  const { getViewport, screenToFlowPosition } = useReactFlow();
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

  const onConnect = useCallback((connection) => {
    if (readOnly) return;
    pushHistory({ nodes, edges, viewport });
    setEdges((current) => addEdge({ ...connection, id: id('edge'), markerEnd: { type: MarkerType.ArrowClosed }, animated: true }, current));
  }, [edges, nodes, pushHistory, readOnly, setEdges, viewport]);

  const onDrop = useCallback((event) => {
    event.preventDefault();
    if (readOnly) return;
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
  }, [edges, nodes, pushHistory, readOnly, screenToFlowPosition, setNodes, viewport]);

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
    onChange?.({ nodes, edges, viewport: getViewport() });
  }, [edges, getViewport, nodes, onChange, viewport]);

  return <CanvasActionsContext.Provider value={{ updateNode }}>
    <div className="learning-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={readOnly ? undefined : handleNodesChange}
        onEdgesChange={readOnly ? undefined : handleEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={(event) => event.preventDefault()}
        onMoveEnd={() => setViewport(getViewport())}
        fitView
        fitViewOptions={{ padding: 0.22 }}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        minZoom={0.35}
        maxZoom={1.8}
        defaultViewport={initial.viewport}
      >
        <Background color="#7e8ed8" gap={24} size={1} />
        <MiniMap pannable zoomable className="learning-canvas__minimap" />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="learning-canvas__tip">拖动卡片、从圆点连线；双击空白处可平移和缩放画布。</div>
    </div>
  </CanvasActionsContext.Provider>;
}

export function CanvasEditor(props) {
  return <ReactFlowProvider><CanvasSurface {...props} /></ReactFlowProvider>;
}
