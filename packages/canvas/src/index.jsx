import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  BaseEdge,
  ConnectionMode,
  EdgeLabelRenderer,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  getBezierPath,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStoreApi,
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
    // 框体尺寸既不落库也不恢复：卡片多大由内容（素材画幅）决定，学生不能手动缩放卡片
    // （见第四节画布约定第 16 条）。历史快照里存过的 width/height 在这里一并丢掉。
    nodes: (Array.isArray(snapshot.nodes) ? snapshot.nodes : []).map(dropNodeSize),
    edges: Array.isArray(snapshot.edges) ? snapshot.edges : [],
    viewport: { ...EMPTY_VIEWPORT, ...(snapshot.viewport || {}) },
  };
}

function dropNodeSize(node) {
  if (!node || (!node.width && !node.height && !node.style)) return node;
  const next = { ...node };
  delete next.width;
  delete next.height;
  if (next.style) {
    const style = { ...next.style };
    delete style.width;
    delete style.height;
    next.style = Object.keys(style).length ? style : undefined;
  }
  return next;
}

// 素材画幅（9:16 / 16:9 / 1:1 …）→ CSS 变量，决定卡片里素材区的大小与比例：
// 9:16 的槽位就该是一张竖卡（参考的节点也是各自按素材比例），要看大用画布缩放。
function aspectRatioVars(value) {
  const matched = String(value || '').match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/i);
  if (!matched) return undefined;
  const width = Number(matched[1]);
  const height = Number(matched[2]);
  if (!(width > 0) || !(height > 0)) return undefined;
  return { '--cv-ratio-w': String(width), '--cv-ratio-h': String(height) };
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

// 框体两侧的连接点（复刻参考节点两侧的小圆 ＋）：从这里拖出连线，松手落在另一个框体的圆点上就建立连接。
// 注意两点：① React Flow 的 Handle 必须在 .learning-node 外面渲染——卡片有 overflow:hidden，
// 放里面贴边的圆点会被裁掉半个；② 两侧都声明成 source，配合 ReactFlow 的 Loose 模式，
// 任意一个圆点既能起线也能接收，学生从左边往右拉、从右边往左拉都行（不做自动连接，连哪由学生拖出来）。
function NodePort({ side }) {
  return <Handle
    id={side}
    type="source"
    position={side === 'left' ? Position.Left : Position.Right}
    className={`learning-node__port is-${side}`}
    title="拖动这里连线到另一个框体"
    aria-label={side === 'left' ? '从左侧拖出连线' : '从右侧拖出连线'}
  >
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
  </Handle>;
}

function NodeFrame({ icon, tone, title, children, selected, aspectRatio = '', variant = 'card', processing = false, onRename = null, renameDisabled = false }) {
  const actions = useContext(CanvasActionsContext);
  const readOnly = Boolean(actions?.readOnly);
  // 标题默认是纯文本、双击才变输入框：单击就能编辑的话，学生想拖卡片往往点进输入框里，
  // 拖不动还以为卡了（输入框是 nodrag 的）。改名的输入框也只占标题栏一小段，剩下的地方留给拖动。
  const [renaming, setRenaming] = useState(false);
  const canRename = Boolean(onRename) && !readOnly && !renameDisabled;
  const closeRename = () => setRenaming(false);
  // 卡片尺寸由「内容 + 素材画幅」决定，没有缩放手柄（拖动框体只挪位置，改大小用画布缩放）。
  // 标题：默认纯文本、双击才进编辑；素材类框体（下方 variant="media"）把它当图片上方的说明文字用
  const titleNode = canRename && renaming
    ? <input
      className="learning-node__title nodrag"
      value={title || ''}
      placeholder="给这个框体取个名字"
      maxLength={40}
      autoFocus
      aria-label="框体名称"
      onChange={(event) => onRename(event.target.value)}
      onBlur={closeRename}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur(); }}
    />
    : <strong
      className="learning-node__title-text"
      title={canRename ? '双击改名' : undefined}
      onDoubleClick={(event) => { if (!canRename) return; event.stopPropagation(); setRenaming(true); }}
    >{title || (canRename ? '未命名框体' : '')}</strong>;
  const ports = <><NodePort side="left" /><NodePort side="right" /></>;
  // 素材类框体（图片/视频/动画）用参考那种展示方式（用户反馈「图3 很难看，像图2那样设计」）：
  // 标题缩成画面左上方的一行小字，画面本体就是卡片本身——不套深色卡片、不套深色内框。
  if (variant === 'media') {
    return <>
      {ports}
      <div className={`learning-node learning-node--${tone} learning-node--media${processing ? ' is-processing' : ''}`} style={aspectRatioVars(aspectRatio)}>
        <div className="learning-node__caption"><span className="learning-node__caption-icon">{icon}</span>{titleNode}</div>
        {children}
      </div>
    </>;
  }
  return <>
    {ports}
    <div className={`learning-node learning-node--${tone}${processing ? ' is-processing' : ''}`} style={aspectRatioVars(aspectRatio)}>
      <div className="learning-node__heading">
        <span>{icon}</span>
        {titleNode}
      </div>
      {children}
    </div>
  </>;
}

// 节点底部面板的页脚：左侧状态胶囊 + 右侧生成按钮（复刻参考底部面板的页脚）
function PanelFooter({ state, error, label = '生成', disabled = false, hint, onGenerate, extra = null }) {
  const text = state === 'running' ? '生成中…' : state === 'failed' ? (error || '生成失败') : state === 'done' ? '已生成' : state === 'asset' ? '素材' : '未生成';
  const tone = state === 'running' ? ' is-running' : state === 'failed' ? ' is-error' : (state === 'done' || state === 'asset') ? ' is-done' : '';
  return <div className="learning-node__panel-footer nodrag">
    <span className={`learning-node__status-chip${tone}`}>{text}</span>
    {extra}
    {onGenerate && state !== 'running' ? <button type="button" className="learning-node__submit" disabled={disabled} title={hint || label} onClick={onGenerate}>{label}<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg></button> : null}
  </div>;
}

// 视频框体的「首帧 / 尾帧 / 参考素材」行：素材靠连线引进来（学生可从桌面拖文件进来再连线），未连时给明确提示
function FrameRefRows({ incoming, referenceUrl, omni, referenceAssets, supportsFirstFrame, supportsLastFrame }) {
  if (omni) {
    const count = (referenceAssets || []).length;
    return <div className="learning-node__ref-row">
      <span className="learning-node__seg-label">参考</span>
      {count ? <span className="learning-node__ref-chip is-on">已连接 {count} 个素材</span> : <span className="learning-node__ref-empty">未连接（图片/视频/音频连过来即可）</span>}
    </div>;
  }
  if (!supportsFirstFrame && !supportsLastFrame) return null;
  const first = incoming[0] || referenceUrl || '';
  const last = supportsLastFrame ? String(incoming[1] || '') : '';
  const chip = (url, name) => url
    ? <figure className="learning-node__frame-chip"><img src={url} alt={name} /><figcaption>{name} · 已连接</figcaption></figure>
    : <span className="learning-node__ref-empty">{name}未连接（从图片节点连过来）</span>;
  return <div className="learning-node__ref-row">
    <span className="learning-node__seg-label">画面</span>
    <div className="learning-node__frame-chips">{chip(first, '首帧')}{supportsLastFrame ? chip(last, '尾帧') : null}</div>
  </div>;
}

// 文字框体：卡片只负责展示（标题 + 生成结果），提示词与生成按钮都在画布底部面板里。
function PromptNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  const generated = String(data.generatedText || '');
  return <NodeFrame icon="✎" tone="prompt" aspectRatio={data.aspectRatio} processing={data.generationStatus === 'PENDING'} title={data.title} selected={selected} onRename={(value) => updateNode(id, { title: value })}>
    {generated
      ? <div className="learning-node__text-result nodrag">{generated}</div>
      : <div className="learning-node__art"><span>✎</span><small>{data.slotType === 'text' ? '在底部面板写提示词，生成文字' : '在底部面板写下内容'}</small></div>}
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

// 平台没给框体定参数时，学生在画布上自己挑。用参考那套「标签 + 分段胶囊」排版：
// 选中项是主色实心胶囊，其余是暗色文字、悬停提亮；「自动」= 不下发该参数、用模型默认值。
function SlotParamPickers({ id, data }) {
  const { updateNode, readOnly } = useCanvasActions();
  const options = data.paramOptions;
  if (readOnly || !data.slotType || !options) return null;
  const student = data.studentParams || {};
  const rows = [];
  if (!data.aspectRatio && Array.isArray(options.aspectRatios) && options.aspectRatios.length) rows.push({ key: 'aspectRatio', label: '画幅', items: options.aspectRatios.map((value) => ({ value, label: value })) });
  if (!data.resolution && Array.isArray(options.resolutions) && options.resolutions.length) rows.push({ key: 'resolution', label: '清晰度', items: options.resolutions.map((value) => ({ value, label: value })) });
  const durationOpen = data.slotType === 'video' && (data.durationSeconds === null || data.durationSeconds === undefined);
  if (durationOpen && Array.isArray(options.durations) && options.durations.length) rows.push({ key: 'durationSeconds', label: '时长', items: options.durations.map((value) => ({ value: String(value), label: `${value} 秒` })) });
  const audioOpen = data.slotType === 'video' && data.audio !== true && data.audio !== false && options.audio === true;
  if (!rows.length && !audioOpen) return null;
  const update = (key, value) => updateNode(id, { studentParams: { ...student, [key]: value } });
  return <div className="learning-node__seg-rows nodrag">
    {rows.map((row) => <div className="learning-node__seg-row" key={row.key}>
      <span className="learning-node__seg-label">{row.label}</span>
      <div className="learning-node__seg" role="group" aria-label={`${data.title || '框体'}${row.label}`}>
        <button type="button" className={student[row.key] ? '' : 'is-on'} title={`按课程默认（${row.items[0].label}）`} onClick={() => update(row.key, '')}>自动</button>
        {row.items.map((item) => <button type="button" key={item.value} className={String(student[row.key]) === item.value ? 'is-on' : ''} onClick={() => update(row.key, item.value)}>{item.label}</button>)}
      </div>
    </div>)}
    {audioOpen ? <div className="learning-node__seg-row">
      <span className="learning-node__seg-label">音频</span>
      <div className="learning-node__seg" role="group" aria-label={`${data.title || '框体'}音频`}>
        <button type="button" className={student.audio === true ? '' : 'is-on'} onClick={() => update('audio', false)}>不带音频</button>
        <button type="button" className={student.audio === true ? 'is-on' : ''} onClick={() => update('audio', true)}>带音频</button>
      </div>
    </div> : null}
  </div>;
}

// 组装这次生成要用的参数：平台定过的用平台的，没定的用学生选的（没选就取第一个可选项）。
function resolveSlotParams(data) {
  const options = data.paramOptions || {};
  const student = data.studentParams || {};
  const params = {
    aspectRatio: data.aspectRatio || student.aspectRatio || options.aspectRatios?.[0] || '',
    resolution: data.resolution || student.resolution || options.resolutions?.[0] || '',
  };
  if (data.slotType === 'video') {
    const duration = Number(data.durationSeconds) || Number(student.durationSeconds) || options.durations?.[0] || 0;
    if (duration) params.durationSeconds = duration;
    params.audio = (data.audio === true || data.audio === false ? data.audio : student.audio === true) && options.audio === true;
  }
  return params;
}

function ImageNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  const imageUrl = data.previewUrl || data.assetUrl;
  // 框体预置素材：老师为这个框体上传的参考图，生成前先给学生看。
  const referenceUrl = !imageUrl ? String(data.referenceUrl || '') : '';
  return <NodeFrame icon="✦" tone="image" aspectRatio={data.aspectRatio} variant="media" processing={data.generationStatus === 'PENDING'} title={data.title} selected={selected} onRename={(value) => updateNode(id, { title: value })}>
    {imageUrl
      ? <img className="learning-node__media" src={imageUrl} alt={data.caption || 'AI生成画面'} />
      : referenceUrl
        // 画面本体就是卡片：不再套 figure +「框体预置素材」那行说明（底部面板里已经写了来源）
        ? <img className="learning-node__media" src={referenceUrl} alt="框体预置素材" />
        : <div className="learning-node__art"><span>{data.emoji || '🌈'}</span><small>在底部面板写画面描述，生成画面</small></div>}
  </NodeFrame>;
}
function CharacterNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="♙" tone="character" aspectRatio={data.aspectRatio} processing={data.generationStatus === 'PENDING'} title={data.title || '故事角色'} selected={selected}>
    <div className="learning-node__character-art">{data.emoji || '🧒'}</div>
    <input className="learning-node__input nodrag" value={data.name || ''} placeholder="角色名字" maxLength={40} onChange={(event) => updateNode(id, { name: event.target.value })} />
    <input className="learning-node__input learning-node__input--compact nodrag" value={data.trait || ''} placeholder="性格、能力或目标" maxLength={80} onChange={(event) => updateNode(id, { trait: event.target.value })} />
    <input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="角色表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />
    {selected && <span className="learning-node__hint">先介绍角色，再把它连接到场景和故事片段</span>}
  </NodeFrame>;
}

function SceneNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="⌂" tone="scene" aspectRatio={data.aspectRatio} processing={data.generationStatus === 'PENDING'} title={data.title || '故事场景'} selected={selected}>
    <div className="learning-node__scene-art"><span>{data.emoji || '🌲'}</span><small>{data.mood || '神秘氛围'}</small></div>
    <input className="learning-node__input nodrag" value={data.place || ''} placeholder="场景地点" maxLength={60} onChange={(event) => updateNode(id, { place: event.target.value })} />
    <input className="learning-node__input learning-node__input--compact nodrag" value={data.mood || ''} placeholder="氛围，例如：温暖、紧张" maxLength={80} onChange={(event) => updateNode(id, { mood: event.target.value })} />
    <input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="场景表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />
    {selected && <span className="learning-node__hint">记录故事发生的地点和氛围，让画面更完整</span>}
  </NodeFrame>;
}

function VideoNode({ id, data, selected }) {
  const { updateNode, getIncomingImageAssetUrls } = useCanvasActions();
  const videoUrl = data.previewUrl || data.assetUrl;
  const inputModes = Array.isArray(data.inputModes) && data.inputModes.length
    ? data.inputModes
    : (data.requiresFirstFrame === true ? ['FIRST_FRAME'] : ['TEXT']);
  const supportsFirstFrame = inputModes.includes('FIRST_FRAME');
  const referenceUrl = !videoUrl && supportsFirstFrame ? String(data.referenceUrl || '') : '';
  const incoming = getIncomingImageAssetUrls(id);
  const sourceUrl = referenceUrl || incoming[0] || '';
  return <NodeFrame icon="▶" tone="video" aspectRatio={data.aspectRatio} variant="media" processing={data.generationStatus === 'PENDING'} title={data.title} selected={selected} onRename={(value) => updateNode(id, { title: value })}>
    {videoUrl
      ? <video className="learning-node__media" controls playsInline src={videoUrl} />
      : sourceUrl
        // 画面本体就是卡片，按素材自身比例铺满；画面也可以直接拖着走（不再有「点图放大」）
        ? <img className="learning-node__media" src={sourceUrl} alt="画面来源" />
        : <div className="learning-node__video-preview"><span>▶</span><small>在底部面板写提示词，生成短片</small></div>}
  </NodeFrame>;
}

function NoteNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="☼" tone="note" aspectRatio={data.aspectRatio} processing={data.generationStatus === 'PENDING'} title={data.title || '创作便签'} selected={selected}>
    <textarea className="learning-node__textarea nodrag" value={data.text || ''} placeholder="记录一个创作想法…" maxLength={300} onChange={(event) => updateNode(id, { text: event.target.value })} />
    {selected && <span className="learning-node__hint">便签可以保存你的灵感</span>}
  </NodeFrame>;
}

// 音频节点按本课开放的音频能力提供生成入口（音乐 / 播客 / 配音）。
const AUDIO_MODALITIES = [['MUSIC', '生成音乐']];

function AudioNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  const audioUrl = data.previewUrl || data.assetUrl;
  return <NodeFrame icon="♫" tone="audio" aspectRatio={data.aspectRatio} processing={data.generationStatus === 'PENDING'} title={data.title} selected={selected} onRename={(value) => updateNode(id, { title: value })}>
    {audioUrl
      ? <audio className="learning-node__audio" controls src={audioUrl} />
      : <div className="learning-node__audio-placeholder"><span>♫</span><small>在底部面板写歌词或描述，生成音乐</small></div>}
  </NodeFrame>;
}

function AnimationNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  const videoUrl = data.previewUrl || data.assetUrl;
  return <NodeFrame icon="✧" tone="animation" aspectRatio={data.aspectRatio} variant="media" processing={data.generationStatus === 'PENDING'} title={data.title} selected={selected} onRename={(value) => updateNode(id, { title: value })}>
    {videoUrl
      ? <video className="learning-node__media" controls muted loop src={videoUrl} />
      : <div className="learning-node__animation-placeholder"><span>✧</span><small>在底部面板写提示词，生成动画</small></div>}
  </NodeFrame>;
}

// 连到视频节点上的素材按节点类型归类（全能参考用）
const NODE_ASSET_KIND = Object.freeze({ image: 'IMAGE', video: 'VIDEO', animation: 'VIDEO', audio: 'AUDIO' });

// 连线：干净贝塞尔曲线 + 一段沿路径游走的主色高光（复刻参考的发光连线，方向由光带表达）。
function GlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, source, target }) {
  const { removeEdge } = useCanvasActions();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return <>
    <BaseEdge id={id} path={path} className={`learning-edge${selected ? ' is-selected' : ''}`} />
    <path d={path} className="learning-edge__glow" />
    {selected && removeEdge ? <EdgeLabelRenderer>
      <button
        type="button"
        className="learning-edge__delete nodrag nopan"
        style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        title="删除这条连接"
        aria-label="删除这条连接"
        onClick={(event) => { event.stopPropagation(); removeEdge(id); }}
      >×</button>
    </EdgeLabelRenderer> : null}
  </>;
}
const edgeTypes = { default: GlowEdge };

// 画布底部面板（复刻参考的独立底部面板）：编辑当前选中的框体——
// 提示词 / 画面来源行 / 画幅·清晰度·时长分段胶囊 / 页脚（状态胶囊 + 配置 + ＋ + 生成 ↑）。
function NodeEditPanel({ node, onRequestMaterials }) {
  const { updateNode, generateNode, canGenerate, readOnly, enabledCapabilities, getIncomingImageAssetUrls, getIncomingAssetRefs } = useCanvasActions();
  if (!node) return null;
  const id = node.id;
  const data = node.data || {};
  const slotType = String(data.slotType || node.type || '').toLowerCase();
  const isBox = Boolean(data.boxId);
  const configLabel = (() => {
    const kind = slotType === 'image' ? '生图' : slotType === 'video' ? '生视频' : slotType === 'audio' || slotType === 'music' ? '音乐' : slotType === 'text' || slotType === 'prompt' ? '文字' : '';
    if (!kind) return '未配置';
    const params = [data.aspectRatio, data.resolution].filter(Boolean);
    if (data.model) params.push(data.model);
    if (data.uploaded) return '本地素材';
    return params.length ? `${kind} · ${params.join(' · ')}` : kind;
  })();
  const promptValue = data.slotType === 'image' ? (data.caption || '') : (data.text || data.caption || '');
  const setPrompt = (value) => (data.slotType === 'image' ? updateNode(id, { caption: value }) : updateNode(id, { text: value, caption: value }));
  const placeholder = slotType === 'image' ? '描述画面要画什么…'
    : slotType === 'video' ? '描述画面要如何运动…'
      : slotType === 'music' || slotType === 'audio' ? (data.mode === 'DESCRIPTION' ? '描述你想要的音乐是什么样子…' : '写下要唱的歌词…')
        : slotType === 'animation' ? '动画说明 / 提示词…'
          : '写下你想让 AI 生成什么…';
  const missingPrompt = !String(promptValue).trim();
  const state = data.generationStatus === 'PENDING' ? 'running'
    : data.generationStatus === 'FAILED' ? 'failed'
      : data.uploaded ? 'asset'
        : (data.assetUrl || data.generatedText) ? 'done' : 'empty';
  const generate = (() => {
    if (slotType === 'image') return { modality: 'IMAGE', label: data.assetUrl ? '重新生成' : '生成画面', payload: { title: data.title || '画面灵感', prompt: data.caption || '', params: resolveSlotParams(data) }, blocked: missingPrompt ? '先写下画面描述，再生成' : '' };
    if (slotType === 'video' || slotType === 'animation') {
      const inputModes = Array.isArray(data.inputModes) && data.inputModes.length ? data.inputModes : (data.requiresFirstFrame === true ? ['FIRST_FRAME'] : ['TEXT']);
      const supportsText = inputModes.includes('TEXT');
      const supportsFirstFrame = inputModes.includes('FIRST_FRAME');
      const supportsLastFrame = inputModes.includes('LAST_FRAME');
      const omni = inputModes.includes('OMNI_REFERENCE');
      const incoming = getIncomingImageAssetUrls(id);
      const referenceAssets = omni ? getIncomingAssetRefs(id) : [];
      const sourceAssetUrl = !omni && supportsFirstFrame ? (incoming[0] || String(data.referenceUrl || '')) : '';
      const lastFrameAssetUrl = !omni && supportsFirstFrame && supportsLastFrame ? String(incoming[1] || '') : '';
      const needFrame = supportsFirstFrame && !supportsText && !sourceAssetUrl;
      return {
        modality: 'VIDEO', label: data.assetUrl ? '重新生成' : '生成短片',
        payload: { title: data.title || '故事短片', prompt: data.text || '', sourceAssetUrl, lastFrameAssetUrl, referenceAssets, params: resolveSlotParams(data) },
        blocked: needFrame ? '该模型需要先连接一张画面（首帧）' : (missingPrompt ? '先写下这一段的提示词，再生成' : ''),
      };
    }
    if (slotType === 'music' || slotType === 'audio') {
      const enabled = enabledCapabilities?.has('music');
      return {
        modality: 'MUSIC', label: data.assetUrl ? '重新生成' : '生成音乐',
        payload: { title: data.title || '音频素材', prompt: promptValue, boxId: data.boxId || '' },
        blocked: !enabled ? '本课未开放 AI 音乐' : (missingPrompt ? (data.mode === 'DESCRIPTION' ? '先描述你想要的音乐' : '先写下要唱的歌词') : ''),
      };
    }
    if (slotType === 'text' || slotType === 'prompt') {
      return { modality: 'TEXT', label: data.generatedText ? '重新生成' : '生成文字', payload: { title: data.title || 'AI 文字', prompt: promptValue }, blocked: missingPrompt ? '先写下你想让 AI 写什么' : '' };
    }
    return null;
  })();
  const supportsPrompt = ['text', 'prompt', 'image', 'video', 'audio', 'music', 'animation'].includes(slotType);
  if (!supportsPrompt) {
    return <div className="learning-canvas__panel-inner"><span className="learning-node__seg-label">{data.title || node.type}</span><span className="cv-muted">这个节点直接在卡片上编辑，没有生成参数。</span></div>;
  }
  // 面板上不再重复放「连线引用中」的缩略图条：框体自己就显示着那张画面，下面「参考」那行也写了连接情况。
  // 这一条占 80px 上下，面板一高就更容易压住框体（用户反馈「输入框应该一直在框体下方」）。
  return <div className="learning-canvas__panel-inner">
    <textarea className="learning-node__textarea nodrag" value={promptValue} placeholder={placeholder} maxLength={isBox ? 3000 : 300} disabled={readOnly} onChange={(event) => setPrompt(event.target.value)} />
    {slotType === 'video' || slotType === 'animation' ? <FrameRefRows
      incoming={getIncomingImageAssetUrls(id)}
      referenceUrl={String(data.referenceUrl || '')}
      omni={(Array.isArray(data.inputModes) ? data.inputModes : []).includes('OMNI_REFERENCE')}
      referenceAssets={getIncomingAssetRefs(id)}
      supportsFirstFrame={(Array.isArray(data.inputModes) ? data.inputModes : []).includes('FIRST_FRAME')}
      supportsLastFrame={(Array.isArray(data.inputModes) ? data.inputModes : []).includes('LAST_FRAME')}
    /> : null}
    <SlotParamPickers id={id} data={data} />
    <div className="learning-node__panel-footer nodrag">
      <button type="button" className="learning-canvas__plus" title="打开左侧素材面板" aria-label="打开素材面板" onClick={() => onRequestMaterials?.()}>＋</button>
      <button type="button" className="learning-canvas__config-chip" title="本框体的生成配置来自课时设置" onClick={() => onRequestMaterials?.()}>✦ {configLabel}</button>
      <span className="learning-canvas__panel-spacer" />
      <span className={`learning-node__status-chip${state === 'running' ? ' is-running' : state === 'failed' ? ' is-error' : (state === 'done' || state === 'asset') ? ' is-done' : ''}`}>{state === 'running' ? '生成中…' : state === 'failed' ? (data.generationError || '生成失败') : state === 'done' ? '已生成' : state === 'asset' ? '素材' : '未生成'}</span>
      {canGenerate && generate && state !== 'running' ? <button type="button" className="learning-node__submit" disabled={readOnly || Boolean(generate.blocked)} title={generate.blocked || generate.label} onClick={() => generateNode(id, generate.modality, generate.payload)}>{generate.label}<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg></button> : null}
    </div>
    {generate?.blocked ? <span className="learning-node__generation-state is-error">{generate.blocked}</span> : null}
  </div>;
}

// 连线两端到底接在哪个圆点上：老快照里的连线没有 handle 字段，按左右位置补上。
// 渲染（displayEdges）和查重（onConnect）共用这一套规则，否则一条老连线能从反方向再连一次。
function resolvePortSides(edge, nodeById) {
  const centerX = (node) => (node?.position?.x || 0) + (node?.measured?.width || node?.width || 250) / 2;
  const source = nodeById.get(edge.source);
  const target = nodeById.get(edge.target);
  const forward = !source || !target || centerX(source) <= centerX(target);
  return {
    sourceHandle: edge.sourceHandle || (forward ? 'right' : 'left'),
    targetHandle: edge.targetHandle || (forward ? 'left' : 'right'),
  };
}

// 一条连线只看「哪两个圆点被连上」，方向不算差异：同一对圆点只允许一条线。
function edgePortPairKey(sourceNodeId, sourceHandle, targetNodeId, targetHandle) {
  return [`${sourceNodeId}#${sourceHandle}`, `${targetNodeId}#${targetHandle}`].sort().join('|');
}

const DOCK_WIDTH = 660;
const DOCK_MARGIN = 14;
const DOCK_GAP = 14;
// 初始视野 / 「适配视图」用的分边留白：下边固定留出面板的位置（面板最高约 320px），
// 其余三边给一点点边距。必须写成 px——ReactFlow 把数字当「比例」解析，不是像素。
const CANVAS_FIT_PADDING = { top: '24px', right: '40px', bottom: '320px', left: '40px' };

// 这些字段是「边打字边改」的，连续编辑同一条框体的同一批字段只记一条撤销记录。
const COALESCED_EDIT_KEYS = new Set(['title', 'caption', 'text', 'name', 'trait', 'place', 'mood', 'emoji', 'studentParams', 'audio']);

// 锚点策略（两轮反馈合起来的口径）：
//  - 平移/缩放**进行中**面板不动：实时订阅 transform 会让它一路追着框体跑、追到画布边缘又被夹住，
//    看着像乱动（第七轮用户反馈）；
//  - 松手（onMoveEnd）后重新锚定一次，让面板回到框体下方：否则平移完面板会丢在一边、
//    和框体彻底分家（第九轮用户反馈的「选中素材 + 空格拖画布后面板跑一边去」）。
//  - 拖动框体 / 换选中框体时同样重新锚定。
// 位置用 transform 直接算、不加 CSS 过渡（加了跟随就慢半拍）。
function CanvasDockPanel({ node, containerRef, viewportEpoch = 0, onRequestRoom, onRequestMaterials }) {
  const store = useStoreApi();
  const panelRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const [box, setBox] = useState({ width: 0, height: 0 });

  // 锚点：框体位置变了 / 换了框体 / 画布平移缩放结束（viewportEpoch）时重新取画布 transform
  useLayoutEffect(() => {
    const [x, y, zoom] = store.getState().transform;
    setAnchor((current) => (current && current.x === x && current.y === y && current.zoom === zoom ? current : { x, y, zoom }));
  }, [store, node.id, node.position.x, node.position.y, viewportEpoch]);

  // 面板高度随内容变（分段参数出现/消失、提示词换行），量出来才能判断放得下放不下。
  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return undefined;
    const sync = () => {
      const next = element.offsetHeight;
      setPanelHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    sync();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const sync = () => {
      const rect = element.getBoundingClientRect();
      setBox((current) => (Math.abs(current.width - rect.width) < 0.5 && Math.abs(current.height - rect.height) < 0.5 ? current : { width: rect.width, height: rect.height }));
    };
    sync();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', sync);
      return () => window.removeEventListener('resize', sync);
    }
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  // 首帧还没量到锚点/容器时先用当前画布 transform 兜底，useLayoutEffect 会在绘制前补上
  const [fallbackX, fallbackY, fallbackZoom] = store.getState().transform;
  const transform = anchor || { x: fallbackX, y: fallbackY, zoom: fallbackZoom };
  const zoom = transform.zoom || 1;
  const nodeWidth = (node.measured?.width || node.width || 250) * zoom;
  const nodeHeight = (node.measured?.height || node.height || 160) * zoom;
  const nodeLeft = node.position.x * zoom + transform.x;
  const nodeTop = node.position.y * zoom + transform.y;
  const panelWidth = Math.max(280, Math.min(DOCK_WIDTH, box.width - DOCK_MARGIN * 2));
  // 水平：优先居中于框体。居中会越出画布时改成**与框体的左/右边对齐**——
  // 参考实现是「居中后硬夹住」，框体靠边时面板会被推到离框体很远的地方，看着就是错位。
  const maxX = Math.max(DOCK_MARGIN, box.width - panelWidth - DOCK_MARGIN);
  let x = nodeLeft + nodeWidth / 2 - panelWidth / 2;
  if (x + panelWidth > box.width - DOCK_MARGIN) x = nodeLeft + nodeWidth - panelWidth;
  if (x < DOCK_MARGIN) x = nodeLeft;
  x = Math.min(Math.max(DOCK_MARGIN, x), maxX);
  // 面板**永远**贴在框体下方（参考实现也是永远在下方：y = 框体底边 + 14）。
  // 只在面板会越出画布底边时把它贴住底边，绝不翻到框体上方——翻上去学生就找不着输入框了。
  const idealY = nodeTop + nodeHeight + DOCK_GAP;
  // 越出多少（= 需要把画布上移多少才能让面板完整落在框体下方）
  const overflow = panelHeight ? Math.max(0, idealY + panelHeight - (box.height - DOCK_MARGIN)) : 0;
  let y = idealY;
  if (overflow > 0) y = Math.max(DOCK_MARGIN, idealY - overflow);
  // 面板在框体下方放不下时（继续夹着就会压住框体）：请求把画布上移把位置让出来。
  // 用户前后反馈了三次「输入框应该一直在框体下方」，光夹到底边做不到这一点，只能动画布。
  // 用 260ms 去抖：拖框体/拖画布时会连续变化，停下来才请求一次，避免边拖边弹视图。
  const requestRoomRef = useRef(onRequestRoom);
  requestRoomRef.current = onRequestRoom;
  useEffect(() => {
    if (!requestRoomRef.current || overflow < 8) return undefined;
    const timer = window.setTimeout(() => requestRoomRef.current(overflow), 260);
    return () => window.clearTimeout(timer);
  }, [overflow]);

  // 首帧还没量到容器尺寸时先别画，免得面板在左上角闪一下。
  const ready = box.width > 0;

  return <div
    ref={panelRef}
    className="learning-canvas__panel"
    style={{ width: panelWidth, transform: `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`, visibility: ready ? undefined : 'hidden' }}
  >
    <div className="learning-canvas__beam is-active">
      <NodeEditPanel node={node} onRequestMaterials={onRequestMaterials} />
      <span className="learning-canvas__beam-bloom" aria-hidden="true" />
    </div>
  </div>;
}

const nodeTypes = { prompt: PromptNode, image: ImageNode, character: CharacterNode, scene: SceneNode, video: VideoNode, note: NoteNode, audio: AudioNode, animation: AnimationNode };

function CanvasSurface({ initialSnapshot, readOnly, onChange, onGenerateNode, onUploadFiles, onRequestMaterials, showStarter, capabilities = ['text'], allowNodeCreation = true, focusRequest = null }) {
  // 受控课堂画布（allowNodeCreation=false）默认不使用固定起始底稿，避免空画布每次刷新被自动填充。
  const shouldShowStarter = showStarter === undefined ? (!readOnly && allowNodeCreation) : showStarter;
  const initial = useMemo(() => {
    const restored = safeSnapshot(initialSnapshot);
    return restored.nodes.length || !shouldShowStarter ? restored : createStarterSnapshot();
  }, [initialSnapshot, shouldShowStarter]);
  // 这份快照里有没有存过视角：有就照它显示，没有（新画布）才自动适配一次。
  // 起始底稿（createStarterSnapshot）自带视角，也算存过。
  const hasStoredViewport = useMemo(() => {
    const source = Array.isArray(initialSnapshot?.nodes) && initialSnapshot.nodes.length ? initialSnapshot : initial;
    const zoom = Number(source?.viewport?.zoom);
    return Number.isFinite(zoom) && zoom > 0;
  }, [initial, initialSnapshot]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [viewport, setViewport] = useState(initial.viewport);
  // 画布平移/缩放「结束」的计数：面板靠它在那之后重新锚定一次（过程中不动，见 CanvasDockPanel 注释）
  const [viewportEpoch, setViewportEpoch] = useState(0);
  const [contextMenu, setContextMenu] = useState(null);
  // 底部面板要编辑哪个框体：优先当前选中的，取消选中后沿用上一次（面板不会突然消失）
  const [activeNodeId, setActiveNodeId] = useState(null);
  // setFlowViewport 是 ReactFlow 的命令式视口设置；本组件自己还有一个同名 state（viewport），故改名区分
  const { getViewport, setViewport: setFlowViewport, screenToFlowPosition, setCenter, fitView } = useReactFlow();
  // 面板在框体下方放不下时，把它需要的空间量（像素）换成一个画布上移：内容上移 → 下面腾出位置。
  // ⚠️ 这段必须放在 useReactFlow() 解构**之后**：依赖数组里的 getViewport 是立即求值的，
  // 放前面会踩 TDZ（ReferenceError → 整页白屏；本轮踩过一次）。
  const requestRoom = useCallback((deficit) => {
    const { x, y, zoom } = getViewport();
    setFlowViewport({ x, y: y - Math.min(deficit, 400), zoom });
    setViewportEpoch((n) => n + 1);
  }, [getViewport]);
  const selectedNodeId = (nodes.find((item) => item.selected) || {}).id || null;
  useEffect(() => { if (selectedNodeId) setActiveNodeId(selectedNodeId); }, [selectedNodeId]);
  const activeNode = nodes.find((item) => item.id === activeNodeId) || null;
  const enabledCapabilities = useMemo(() => new Set(Array.isArray(capabilities) && capabilities.length ? capabilities : ['text']), [capabilities]);
  const canvasRef = useRef(null);
  const historyRef = useRef({ past: [], future: [] });
  const clipboardRef = useRef([]);
  const restoringHistoryRef = useRef(false);
  // 拖框体/拖缩放手柄是连续事件（每帧都来一次），只有整段手势记一条历史，
  // 否则一次拖动会攒下几十条记录，撤销只能一点点往回退。
  const gestureRef = useRef(null);
  // 连续输入同一段文字合并成一条历史（键名列表见 COALESCED_EDIT_KEYS）。
  const lastEditRef = useRef({ nodeId: null, at: 0 });

  const pushHistory = useCallback((snapshot) => {
    if (readOnly || restoringHistoryRef.current) return;
    historyRef.current = { past: [...historyRef.current.past.slice(-49), safeSnapshot(snapshot)], future: [] };
  }, [readOnly]);

  const updateNode = useCallback((nodeId, changes) => {
    if (readOnly) return;
    const keys = Object.keys(changes);
    const now = Date.now();
    const typing = keys.length > 0 && keys.every((key) => COALESCED_EDIT_KEYS.has(key));
    const merge = typing && lastEditRef.current.nodeId === nodeId && now - lastEditRef.current.at < 700;
    if (!merge) pushHistory({ nodes, edges, viewport });
    lastEditRef.current = { nodeId, at: now };
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
  // 按连线顺序取连到该节点的图片素材地址：第一条当首帧，第二条当尾帧（首尾帧模型用）。
  const getIncomingImageAssetUrls = useCallback((nodeId) => {
    const sourceIds = (edges || []).filter((edge) => edge.target === nodeId).map((edge) => edge.source);
    return sourceIds
      .map((sourceId) => (nodes || []).find((node) => node.id === sourceId && node.type === 'image'))
      .map((imageNode) => String(imageNode?.data?.assetUrl || imageNode?.data?.previewUrl || '').trim())
      .filter(Boolean);
  }, [edges, nodes]);
  const getIncomingImageAssetUrl = useCallback((nodeId) => getIncomingImageAssetUrls(nodeId)[0] || '', [getIncomingImageAssetUrls]);

  // 全能参考要按类型区分：图片/视频/音频节点连过来的素材各算一类。
  const getIncomingAssetRefs = useCallback((nodeId) => {
    const sourceIds = (edges || []).filter((edge) => edge.target === nodeId).map((edge) => edge.source);
    return sourceIds
      .map((sourceId) => (nodes || []).find((node) => node.id === sourceId))
      .map((node) => {
        const type = NODE_ASSET_KIND[node?.type] || '';
        const url = String(node?.data?.assetUrl || node?.data?.previewUrl || '').trim();
        return type && url ? { type, url } : null;
      })
      .filter(Boolean);
  }, [edges, nodes]);
  const addNodeAt = useCallback((type, position) => {
    if (readOnly || !allowNodeCreation) return;
    const capabilityByType = { prompt: 'text', image: 'image', video: 'video' };
    const requiredCapability = capabilityByType[type];
    const audioEnabled = enabledCapabilities.has('music');
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

  // 删掉一条连线（学生连错了能自己取消，不会定死）
  const removeEdge = useCallback((edgeId) => {
    if (readOnly) return;
    pushHistory({ nodes, edges, viewport });
    setEdges((current) => current.filter((edge) => edge.id !== edgeId));
  }, [edges, nodes, pushHistory, readOnly, setEdges, viewport]);

  // 学生从框体两侧的圆点拖一条线到另一个框体：落点是哪个圆点就记哪个，
  // 这样反向连（从右边的框体往左连）也能连出正确的走向。
  const onConnect = useCallback((connection) => {
    if (readOnly) return;
    const sourceHandle = connection.sourceHandle || 'right';
    const targetHandle = connection.targetHandle || 'left';
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const wanted = edgePortPairKey(connection.source, sourceHandle, connection.target, targetHandle);
    const duplicated = edges.some((edge) => {
      const sides = resolvePortSides(edge, nodeById);
      return edgePortPairKey(edge.source, sides.sourceHandle, edge.target, sides.targetHandle) === wanted;
    });
    if (duplicated) return;
    pushHistory({ nodes, edges, viewport });
    setEdges((current) => addEdge({ ...connection, id: id('edge'), sourceHandle, targetHandle }, current));
  }, [edges, nodes, pushHistory, readOnly, setEdges, viewport]);

  const onDrop = useCallback((event) => {
    event.preventDefault();
    if (readOnly) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = screenToFlowPosition({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    // 从桌面拖进来的图片/视频/音频：交给上层上传后再落成节点（学生画布也允许，不受 allowNodeCreation 限制）
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length && onUploadFiles) { onUploadFiles(files, position); return; }
    if (!allowNodeCreation) return;
    const raw = event.dataTransfer.getData('application/x-learning-material');
    if (!raw) return;
    let material;
    try { material = JSON.parse(raw); } catch { return; }
    const snapshot = material?.snapshot && typeof material.snapshot === 'object' ? material.snapshot : {};
    const sourceData = snapshot.data || snapshot.props || {};
    const materialType = String(material?.materialType || snapshot.type || 'NOTE').toUpperCase();
    const type = snapshot.type || ({ IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio', MUSIC: 'audio', ANIMATION: 'animation', CHARACTER: 'character', SCENE: 'scene', TEXT: 'prompt', PROMPT: 'prompt' }[materialType] || 'note');
    const fallbackData = type === 'image' ? { title: material.title, emoji: '✨', caption: material.description || '' } : type === 'video' ? { title: material.title, text: material.description || '' } : type === 'audio' ? { title: material.title, text: material.description || '', assetUrl: material.assetUrl, previewUrl: material.previewUrl } : type === 'animation' ? { title: material.title, text: material.description || '', assetUrl: material.assetUrl, previewUrl: material.previewUrl } : type === 'character' ? { title: material.title, emoji: '🧒', name: '', trait: material.description || '' } : type === 'scene' ? { title: material.title, emoji: '🌲', place: material.description || '', mood: '' } : { title: material.title, text: material.description || '' };
    pushHistory({ nodes, edges, viewport });
    setNodes((current) => [...current, { id: `material-${Date.now().toString(36)}`, type, position, data: { ...fallbackData, ...sourceData, title: material.title || sourceData.title, lessonMaterialId: material.id, isLessonMaterial: true } }]);
  }, [edges, nodes, onUploadFiles, pushHistory, readOnly, allowNodeCreation, screenToFlowPosition, setNodes, viewport]);

  const handleNodesChange = useCallback((changes) => {
    if (!readOnly && changes.some((change) => change.type !== 'select')) {
      if (changes.some((change) => change.type === 'position' || change.type === 'dimensions')) {
        // 拖动/缩放：手势开始时留一份底稿，手一松开才记一条历史。
        if (changes.some((change) => change.dragging || change.resizing)) {
          if (!gestureRef.current) gestureRef.current = safeSnapshot({ nodes, edges, viewport });
        } else if (gestureRef.current) {
          pushHistory(gestureRef.current);
          gestureRef.current = null;
        }
      } else {
        pushHistory({ nodes, edges, viewport });
      }
    }
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
    lastEditRef.current = { nodeId: null, at: 0 };
    restoringHistoryRef.current = true;
    setNodes(previous.nodes); setEdges(previous.edges); setViewport(previous.viewport);
    window.setTimeout(() => { restoringHistoryRef.current = false; }, 0);
  }, [edges, nodes, readOnly, setEdges, setNodes, viewport]);

  const redo = useCallback(() => {
    const future = historyRef.current.future;
    if (readOnly || !future.length) return;
    const next = future[0];
    historyRef.current = { past: [...historyRef.current.past, safeSnapshot({ nodes, edges, viewport })].slice(-50), future: future.slice(1) };
    lastEditRef.current = { nodeId: null, at: 0 };
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

  // 素材面板点「已在画布上」的框体时，把对应节点选中并移到视野中央（点了要看得见反应）。
  useEffect(() => {
    if (!focusRequest?.id) return;
    const node = nodes.find((item) => item.id === focusRequest.id);
    if (!node) return;
    const width = node.measured?.width || node.width || 250;
    const height = node.measured?.height || node.height || 160;
    setNodes((current) => current.map((item) => ({ ...item, selected: item.id === focusRequest.id })));
    setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: Math.max(getViewport().zoom || 1, 0.8), duration: 400 });
    // 只在每次新的定位请求（token 变化）时执行
  }, [focusRequest?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onChange?.({ nodes, edges, viewport: getViewport() });
  }, [edges, getViewport, nodes, onChange, viewport]);

  // 两侧连接点上线后，连线必须指明从哪一个圆点出入。历史快照里的连线没有 handle 字段，
  // 这里按左右位置补上（只影响渲染，不写回数据，免得把老画布白白标记成「有未保存改动」）。
  const displayEdges = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    return edges.map((edge) => {
      const base = edge.markerEnd ? { ...edge, markerEnd: undefined } : edge;
      if (base.sourceHandle && base.targetHandle) return base;
      return { ...base, ...resolvePortSides(edge, nodeById) };
    });
  }, [edges, nodes]);

  return <CanvasActionsContext.Provider value={{ updateNode, generateNode, canGenerate: Boolean(onGenerateNode), removeEdge, readOnly, enabledCapabilities, getIncomingImageAssetUrl, getIncomingImageAssetUrls, getIncomingAssetRefs }}>
    <div className={`learning-canvas${readOnly ? ' is-readonly' : ''}`} ref={canvasRef}>
      <ReactFlow
        nodes={nodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={readOnly ? undefined : handleNodesChange}
        onEdgesChange={readOnly ? undefined : handleEdgesChange}
        onConnect={onConnect}
        // Loose 模式：两个圆点既能起线也能接收，学生从哪一侧拖都能连上（不会自动连接）
        connectionMode={ConnectionMode.Loose}
        connectionRadius={28}
        // 只认「按住圆点拖到另一个圆点」，单击不会起线（避免学生误点就多一条连线）
        connectOnClick={false}
        connectionLineStyle={{ stroke: 'var(--cv-primary)', strokeWidth: 2.2, strokeLinecap: 'round' }}
        isValidConnection={readOnly ? undefined : (connection) => connection.source !== connection.target}
        onDrop={onDrop}
        onPaneContextMenu={handlePaneContextMenu}
        onPaneClick={() => setContextMenu(null)}
        onDragOver={(event) => event.preventDefault()}
        onMoveEnd={() => { setViewport(getViewport()); setViewportEpoch((n) => n + 1); }}
        // 只有「这份快照还没存过视角」时才自动适配视野；存过就用存下来的视角。
        // 原来无条件写 fitView，于是每次刷新都会重新适配 —— 学生平移/缩放后的视角全丢（用户反馈「刷新全复原」）。
        fitView={!hasStoredViewport}
        // 初始视野：内容靠上、下面留出输入面板的位置。
        // fitView 默认把内容**垂直居中**，而面板贴在被选中框体下方、高 160~320px，
        // 居中时框体下面最多只有 (画布高 - 框体高)/2 的空间——框体长一点面板就必然压住它。
        // 分边 padding 用 px（数字会被当成比例，不是像素），下边固定留 320px。
        fitViewOptions={{ padding: CANVAS_FIT_PADDING, maxZoom: 1.2 }}
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
      {!readOnly && activeNode ? <CanvasDockPanel node={activeNode} containerRef={canvasRef} viewportEpoch={viewportEpoch} onRequestRoom={requestRoom} onRequestMaterials={onRequestMaterials} /> : null}
      {!readOnly && <div className="learning-canvas__toolbar">
        <button type="button" className="learning-canvas__toolbar-btn" title="撤销（Ctrl+Z）" aria-label="撤销" onClick={undo}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 7L4 12l5 5M4 12h9a6 6 0 0 1 6 6"/></svg></button>
        <button type="button" className="learning-canvas__toolbar-btn" title="重做（Ctrl+Y）" aria-label="重做" onClick={redo}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 7l5 5-5 5M20 12h-9a6 6 0 0 0-6 6"/></svg></button>
        <span className="learning-canvas__toolbar-sep" />
        <button type="button" className="learning-canvas__toolbar-btn" title="适配视图" aria-label="适配视图" onClick={() => fitView({ padding: CANVAS_FIT_PADDING, duration: 320, maxZoom: 1.2 })}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/></svg></button>
      </div>}
      <div className="learning-canvas__tip">{allowNodeCreation ? '拖动卡片排布；从卡片两侧的 ＋ 拖一条线连到另一个框体。' : '从左侧「素材」面板添加框体，写好提示词就能生成；从卡片两侧的 ＋ 拖线连接框体，也可以把图片/视频直接拖进画布。'}</div>
      {contextMenu && allowNodeCreation && <div className="learning-canvas__context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
        <strong>创建节点</strong>
        <button type="button" onClick={() => addNodeAt('prompt', contextMenu.position)} disabled={!enabledCapabilities.has('text')}>✎ AI 文字</button>
        <button type="button" onClick={() => addNodeAt('image', contextMenu.position)} disabled={!enabledCapabilities.has('image')}>✦ AI 生图{!enabledCapabilities.has('image') && <small>本课未开放</small>}</button>
        <button type="button" onClick={() => addNodeAt('video', contextMenu.position)} disabled={!enabledCapabilities.has('video')}>▶ AI 生视频{!enabledCapabilities.has('video') && <small>本课未开放</small>}</button>
        <button type="button" onClick={() => addNodeAt('audio', contextMenu.position)} disabled={!(enabledCapabilities.has('music'))}>♫ AI 音频{!(enabledCapabilities.has('music')) && <small>本课未开放</small>}</button>
        <button type="button" onClick={() => addNodeAt('character', contextMenu.position)}>♙ 角色节点</button>
        <button type="button" onClick={() => addNodeAt('scene', contextMenu.position)}>⌂ 场景节点</button>
      </div>}
    </div>
  </CanvasActionsContext.Provider>;
}

export function CanvasEditor(props) {
  return <ReactFlowProvider><CanvasSurface {...props} /></ReactFlowProvider>;
}
