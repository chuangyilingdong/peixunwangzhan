import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  NodeResizer,
  getBezierPath,
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

function NodeFrame({ icon, tone, title, children, selected, minWidth = 220, minHeight = 140, processing = false }) {
  const actions = useContext(CanvasActionsContext);
  const readOnly = Boolean(actions?.readOnly);
  // 缩放把手放在圆角容器外面：.learning-node 有 overflow:hidden（为了裁掉溢出内容），
  // 把手是贴在节点四角、探出边缘的，放里面会被裁掉一半甚至整个点不到。
  return <>
    <NodeResizer isVisible={Boolean(selected) && !readOnly} minWidth={minWidth} minHeight={minHeight} lineClassName="learning-node__resize-line" handleClassName="learning-node__resize-handle" />
    <div className={`learning-node learning-node--${tone}${processing ? ' is-processing' : ''}`}>
      <Handle type="target" position={Position.Left} className="learning-node__handle" />
      <div className="learning-node__heading"><span>{icon}</span><strong>{title}</strong></div>
      {children}
      <Handle type="source" position={Position.Right} className="learning-node__handle" />
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

function PromptNode({ id, data, selected }) {
  const { updateNode, generateNode, canGenerate } = useCanvasActions();
  const generated = String(data.generatedText || '');
  const missingPrompt = !String(data.text || '').trim();
  const isTextSlot = data.slotType === 'text';
  return <NodeFrame icon="✎" tone="prompt" processing={data.generationStatus === 'PENDING'} title={data.title || '魔法提示词'} selected={selected}>
    <div className="learning-node__panel">
      <textarea className="learning-node__textarea nodrag" value={data.text || ''} placeholder={isTextSlot ? '写下你想让 AI 生成什么…' : '写下你的故事或画面描述…'} maxLength={300} onChange={(event) => updateNode(id, { text: event.target.value })} />
      <span className="learning-node__count">{(data.text || '').length}/300</span>
      <SlotParams data={data} />
      {generated ? <div className="learning-node__text-result nodrag">{generated}</div> : null}
      <PanelFooter
        state={data.generationStatus === 'PENDING' ? 'running' : data.generationStatus === 'FAILED' ? 'failed' : generated ? 'done' : 'empty'}
        error={data.generationError}
        label={generated ? '重新生成' : '生成文字'}
        disabled={missingPrompt}
        hint={missingPrompt ? '先写下你想让 AI 写什么' : '让 AI 帮你写'}
        onGenerate={canGenerate && isTextSlot ? () => generateNode(id, 'TEXT', { title: data.title || 'AI 文字', prompt: data.text || '' }) : null}
      />
    </div>
    {selected && <span className="learning-node__hint">写下提示词后点右下角生成，AI 帮你写；也可以直接手动编辑。</span>}
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
  const { updateNode, generateNode, canGenerate, openPreview } = useCanvasActions();
  const imageUrl = data.previewUrl || data.assetUrl;
  const missingPrompt = !String(data.caption || '').trim();
  // 框体预置素材：老师为这个框体上传的参考图，生成前先给学生看。
  const referenceUrl = !imageUrl ? String(data.referenceUrl || '') : '';
  return <NodeFrame icon="✦" tone="image" processing={data.generationStatus === 'PENDING'} title={data.title || '画面灵感'} selected={selected}>
    {imageUrl
      ? <img className="learning-node__media learning-node__media--zoomable nodrag" src={imageUrl} alt={data.caption || 'AI生成画面'} onClick={() => openPreview(imageUrl)} title="点击放大查看" />
      : referenceUrl
        ? <figure className="learning-node__reference nodrag"><img src={referenceUrl} alt="框体预置素材" title="点击放大查看" onClick={() => openPreview(referenceUrl)} /><figcaption>框体预置素材</figcaption></figure>
        : <div className="learning-node__art"><span>{data.emoji || '🌈'}</span><small>写画面描述，点右下角生成画面</small></div>}
    <div className="learning-node__panel">
      <textarea className="learning-node__textarea nodrag" value={data.caption || ''} placeholder="描述画面要画什么…" maxLength={300} onChange={(event) => updateNode(id, { caption: event.target.value })} />
      <SlotParams data={data} />
      <SlotParamPickers id={id} data={data} />
      <PanelFooter
        state={data.generationStatus === 'PENDING' ? 'running' : data.generationStatus === 'FAILED' ? 'failed' : data.uploaded && imageUrl ? 'asset' : imageUrl ? 'done' : 'empty'}
        error={data.generationError}
        label={imageUrl ? '重新生成' : '生成画面'}
        disabled={missingPrompt}
        hint={missingPrompt ? '先写下画面描述，再生成' : '按描述生成画面'}
        onGenerate={canGenerate && !imageUrl ? () => generateNode(id, 'IMAGE', { title: data.title || '画面灵感', prompt: data.caption || '', params: resolveSlotParams(data) }) : null}
        extra={<input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="画面表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />}
      />
    </div>
    {selected && <span className="learning-node__hint">用描述生成画面，也可以继续编辑灵感</span>}
  </NodeFrame>;
}
function CharacterNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="♙" tone="character" processing={data.generationStatus === 'PENDING'} title={data.title || '故事角色'} selected={selected}>
    <div className="learning-node__character-art">{data.emoji || '🧒'}</div>
    <input className="learning-node__input nodrag" value={data.name || ''} placeholder="角色名字" maxLength={40} onChange={(event) => updateNode(id, { name: event.target.value })} />
    <input className="learning-node__input learning-node__input--compact nodrag" value={data.trait || ''} placeholder="性格、能力或目标" maxLength={80} onChange={(event) => updateNode(id, { trait: event.target.value })} />
    <input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="角色表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />
    {selected && <span className="learning-node__hint">先介绍角色，再把它连接到场景和故事片段</span>}
  </NodeFrame>;
}

function SceneNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="⌂" tone="scene" processing={data.generationStatus === 'PENDING'} title={data.title || '故事场景'} selected={selected}>
    <div className="learning-node__scene-art"><span>{data.emoji || '🌲'}</span><small>{data.mood || '神秘氛围'}</small></div>
    <input className="learning-node__input nodrag" value={data.place || ''} placeholder="场景地点" maxLength={60} onChange={(event) => updateNode(id, { place: event.target.value })} />
    <input className="learning-node__input learning-node__input--compact nodrag" value={data.mood || ''} placeholder="氛围，例如：温暖、紧张" maxLength={80} onChange={(event) => updateNode(id, { mood: event.target.value })} />
    <input className="learning-node__emoji nodrag" value={data.emoji || ''} aria-label="场景表情" maxLength={2} onChange={(event) => updateNode(id, { emoji: event.target.value })} />
    {selected && <span className="learning-node__hint">记录故事发生的地点和氛围，让画面更完整</span>}
  </NodeFrame>;
}

function VideoNode({ id, data, selected }) {
  const { updateNode, generateNode, canGenerate, getIncomingImageAssetUrls, getIncomingAssetRefs } = useCanvasActions();
  const videoUrl = data.previewUrl || data.assetUrl;
  // 输入画面按模型声明的方式给（可多选）：支持文生就可以不带图；支持首帧才用连过来的图/框体预置素材；
  // 支持尾帧才用第二张连过来的图。不支持的方式一律不送，服务端也会再拦一次。
  const inputModes = Array.isArray(data.inputModes) && data.inputModes.length
    ? data.inputModes
    : (data.requiresFirstFrame === true ? ['FIRST_FRAME'] : ['TEXT']);
  const supportsFirstFrame = inputModes.includes('FIRST_FRAME');
  const supportsLastFrame = inputModes.includes('LAST_FRAME');
  const supportsText = inputModes.includes('TEXT');
  const missingPrompt = !String(data.text || '').trim();
  const referenceUrl = !videoUrl && supportsFirstFrame ? String(data.referenceUrl || '') : '';
  const incoming = getIncomingImageAssetUrls(id);
  const omni = inputModes.includes('OMNI_REFERENCE');
  // 全能参考与首/尾帧互斥（上游不允许混用）：声明了全能参考就按参考素材发，否则按首/尾帧发。
  const referenceAssets = omni ? getIncomingAssetRefs(id) : [];
  const sourceAssetUrl = !omni && supportsFirstFrame ? (incoming[0] || referenceUrl) : '';
  const lastFrameAssetUrl = !omni && supportsFirstFrame && supportsLastFrame ? String(incoming[1] || '') : '';
  const missingFirstFrame = supportsFirstFrame && !supportsText && !sourceAssetUrl;
  const blockedReason = missingFirstFrame
    ? '该模型需要先连接一张画面（首帧）'
    : (missingPrompt ? '先写下这一段的提示词，再生成' : '');
  const frameHint = omni
    ? '把图片/视频/音频节点连过来当参考素材（图 ≤9、视频 ≤3、音频 ≤3）'
    : (supportsFirstFrame && supportsLastFrame
      ? '按连线顺序：第一条图片连线当首帧，第二条当尾帧'
      : (supportsFirstFrame ? '从图片节点的圆点连过来当首帧' : '该模型只吃文本提示词'));
  return <NodeFrame icon="▶" tone="video" processing={data.generationStatus === 'PENDING'} title={data.title || '故事短片'} selected={selected}>
    {videoUrl
      ? <video className="learning-node__media" controls playsInline src={videoUrl} />
      : referenceUrl
        ? <figure className="learning-node__reference nodrag"><img src={referenceUrl} alt="框体预置首帧" /><figcaption>框体预置首帧</figcaption></figure>
        : <div className="learning-node__video-preview"><span>▶</span><small>写提示词，点右下角生成短片</small></div>}
    <div className="learning-node__panel">
      <textarea className="learning-node__textarea nodrag" value={data.text || ''} placeholder="描述画面要如何运动…" maxLength={300} onChange={(event) => updateNode(id, { text: event.target.value })} />
      <FrameRefRows incoming={incoming} referenceUrl={referenceUrl} omni={omni} referenceAssets={referenceAssets} supportsFirstFrame={supportsFirstFrame} supportsLastFrame={supportsLastFrame} />
      <SlotParams data={data} />
      <SlotParamPickers id={id} data={data} />
      <PanelFooter
        state={data.generationStatus === 'PENDING' ? 'running' : data.generationStatus === 'FAILED' ? 'failed' : data.uploaded && videoUrl ? 'asset' : videoUrl ? 'done' : 'empty'}
        error={data.generationError}
        label={videoUrl ? '重新生成' : '生成短片'}
        disabled={Boolean(blockedReason) && !videoUrl}
        hint={blockedReason || '按提示词生成短片'}
        onGenerate={canGenerate ? () => generateNode(id, 'VIDEO', { title: data.title || '故事短片', prompt: data.text || '', sourceAssetUrl, lastFrameAssetUrl, referenceAssets, params: resolveSlotParams(data) }) : null}
      />
      {blockedReason && !data.generationStatus && !videoUrl ? <span className="learning-node__generation-state is-error">{blockedReason}</span> : null}
    </div>
    {selected && <span className="learning-node__hint">{frameHint}</span>}
  </NodeFrame>;
}

function NoteNode({ id, data, selected }) {
  const { updateNode } = useCanvasActions();
  return <NodeFrame icon="☼" tone="note" processing={data.generationStatus === 'PENDING'} title={data.title || '创作便签'} selected={selected}>
    <textarea className="learning-node__textarea nodrag" value={data.text || ''} placeholder="记录一个创作想法…" maxLength={300} onChange={(event) => updateNode(id, { text: event.target.value })} />
    {selected && <span className="learning-node__hint">便签可以保存你的灵感</span>}
  </NodeFrame>;
}

// 音频节点按本课开放的音频能力提供生成入口（音乐 / 播客 / 配音）。
const AUDIO_MODALITIES = [['MUSIC', '生成音乐']];

function AudioNode({ id, data, selected }) {
  const { updateNode, generateNode, canGenerate, enabledCapabilities } = useCanvasActions();
  const audioUrl = data.previewUrl || data.assetUrl;
  const isBoxNode = Boolean(data.boxId);
  const musicMode = data.mode === 'DESCRIPTION' ? 'DESCRIPTION' : 'LYRICS';
  const missingPrompt = !String(data.text || data.caption || '').trim();
  const available = AUDIO_MODALITIES.filter(([modality]) => enabledCapabilities?.has(modality.toLowerCase()));
  const buttons = isBoxNode ? [['MUSIC', audioUrl ? '重新生成' : '生成音乐']] : available.map(([modality, label]) => [modality, label]);
  const canRun = isBoxNode ? enabledCapabilities?.has('music') : available.length > 0;
  const hint = musicMode === 'DESCRIPTION' ? '先写下你想要的音乐是什么样子' : '先写下要唱的歌词';
  return <NodeFrame icon="♫" tone="audio" processing={data.generationStatus === 'PENDING'} title={data.title || '音频素材'} selected={selected}>
    {audioUrl ? <audio className="learning-node__audio" controls src={audioUrl} /> : <div className="learning-node__audio-placeholder"><span>♫</span><small>写歌词或描述，点右下角生成音乐</small></div>}
    <div className="learning-node__panel">
      <textarea className="learning-node__textarea nodrag" value={data.text || data.caption || ''} placeholder={isBoxNode && musicMode === 'DESCRIPTION' ? '描述你想要的音乐是什么样子…' : (isBoxNode ? '写下要唱的歌词…' : '音频说明 / 提示词')} maxLength={isBoxNode ? 3000 : 180} onChange={(event) => updateNode(id, { text: event.target.value, caption: event.target.value })} />
      {isBoxNode ? <SlotParams data={{ slotType: 'music', model: data.model, resolution: musicMode === 'DESCRIPTION' ? '描述生音乐（平台代写词）' : '歌词生音乐' }} /> : null}
      <PanelFooter
        state={data.generationStatus === 'PENDING' ? 'running' : data.generationStatus === 'FAILED' ? 'failed' : data.uploaded && audioUrl ? 'asset' : audioUrl ? 'done' : 'empty'}
        error={data.generationError}
        label={buttons[0]?.[1] || '生成音乐'}
        disabled={missingPrompt || !canRun}
        hint={missingPrompt ? hint : '按歌词/描述生成音乐'}
        onGenerate={canGenerate && buttons.length ? () => generateNode(id, buttons[0][0], { title: data.title || '音频素材', prompt: data.text || data.caption || '', boxId: data.boxId || '' }) : null}
      />
      {missingPrompt && !data.generationStatus && isBoxNode ? <span className="learning-node__generation-state is-error">{hint}</span> : null}
    </div>
    {selected && <span className="learning-node__hint">可播放课程音频或音乐；本课开放哪几种音频能力，就能生成哪几种</span>}
  </NodeFrame>;
}

function AnimationNode({ id, data, selected }) {
  const { updateNode, generateNode, canGenerate, enabledCapabilities } = useCanvasActions();
  const videoUrl = data.previewUrl || data.assetUrl;
  return <NodeFrame icon="✧" tone="animation" processing={data.generationStatus === 'PENDING'} title={data.title || '动画素材'} selected={selected}>
    {videoUrl ? <video className="learning-node__media" controls muted loop src={videoUrl} /> : <div className="learning-node__animation-placeholder"><span>✧</span><small>写提示词，点右下角生成动画</small></div>}
    <div className="learning-node__panel">
      <input className="learning-node__input nodrag" value={data.text || data.caption || ''} placeholder="动画说明 / 提示词" maxLength={180} onChange={(event) => updateNode(id, { text: event.target.value, caption: event.target.value })} />
      <PanelFooter
        state={data.generationStatus === 'PENDING' ? 'running' : data.generationStatus === 'FAILED' ? 'failed' : videoUrl ? 'done' : 'empty'}
        error={data.generationError}
        label={videoUrl ? '重新生成' : '生成动画'}
        disabled={!enabledCapabilities?.has('video')}
        hint={enabledCapabilities?.has('video') ? '按说明生成动画' : '本课未开放 AI 生视频'}
        onGenerate={canGenerate && enabledCapabilities?.has('video') ? () => generateNode(id, 'VIDEO', { title: data.title || '动画素材', prompt: data.text || data.caption || '' }) : null}
      />
    </div>
    {selected && <span className="learning-node__hint">动画按视频能力生成；本课未开放 AI 生视频时不能生成</span>}
  </NodeFrame>;
}

// 连到视频节点上的素材按节点类型归类（全能参考用）
const NODE_ASSET_KIND = Object.freeze({ image: 'IMAGE', video: 'VIDEO', animation: 'VIDEO', audio: 'AUDIO' });

// 连线：干净贝塞尔曲线 + 一段沿路径游走的主色高光（复刻参考的发光连线，方向由光带表达）。
function GlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected }) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return <>
    <BaseEdge id={id} path={path} className={`learning-edge${selected ? ' is-selected' : ''}`} />
    <path d={path} className="learning-edge__glow" />
  </>;
}
const edgeTypes = { default: GlowEdge };

const nodeTypes = { prompt: PromptNode, image: ImageNode, character: CharacterNode, scene: SceneNode, video: VideoNode, note: NoteNode, audio: AudioNode, animation: AnimationNode };

function CanvasSurface({ initialSnapshot, readOnly, onChange, onGenerateNode, onUploadFiles, showStarter, capabilities = ['text'], allowNodeCreation = true, focusRequest = null }) {
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
  const { getViewport, screenToFlowPosition, setCenter, fitView } = useReactFlow();
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

  const onConnect = useCallback((connection) => {
    if (readOnly) return;
    pushHistory({ nodes, edges, viewport });
    setEdges((current) => addEdge({ ...connection, id: id('edge'), markerEnd: { type: MarkerType.ArrowClosed }, animated: true }, current));
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

  return <CanvasActionsContext.Provider value={{ updateNode, generateNode, canGenerate: Boolean(onGenerateNode), openPreview: setPreviewImage, readOnly, enabledCapabilities, getIncomingImageAssetUrl, getIncomingImageAssetUrls, getIncomingAssetRefs }}>
    <div className="learning-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges.map((edge) => (edge.markerEnd ? { ...edge, markerEnd: undefined } : edge))}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
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
      {!readOnly && <div className="learning-canvas__toolbar">
        <button type="button" className="learning-canvas__toolbar-btn" title="撤销（Ctrl+Z）" aria-label="撤销" onClick={undo}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 7L4 12l5 5M4 12h9a6 6 0 0 1 6 6"/></svg></button>
        <button type="button" className="learning-canvas__toolbar-btn" title="重做（Ctrl+Y）" aria-label="重做" onClick={redo}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 7l5 5-5 5M20 12h-9a6 6 0 0 0-6 6"/></svg></button>
        <span className="learning-canvas__toolbar-sep" />
        <button type="button" className="learning-canvas__toolbar-btn" title="适配视图" aria-label="适配视图" onClick={() => fitView({ padding: 0.22, duration: 320 })}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/></svg></button>
      </div>}
      <div className="learning-canvas__tip">{allowNodeCreation ? '拖动卡片、从圆点连线；右键空白处可创建节点。' : '从左侧「素材」面板添加框体，写好提示词就能生成；也可以把图片/视频直接拖进画布。'}</div>
      {previewImage && <div className="learning-canvas__lightbox" role="dialog" aria-modal="true" onClick={() => setPreviewImage(null)}><img src={previewImage} alt="素材预览" onClick={(event) => event.stopPropagation()} /><button type="button" className="learning-canvas__lightbox-close" onClick={() => setPreviewImage(null)}>×</button></div>}
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
