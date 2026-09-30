import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';   // createCanvasTemplate 全仓零使用（2026-09-26 审计）
import { Icon } from './icons.jsx';
import { materialVisual } from './materialTypes.js';
import { readSession } from './auth.js';
// 框体 → 画布节点的唯一一份实现（备课画布与学生画布共用，别各写一份）
import { boxParamsLabel, buildBoxNode } from './canvasBoxNode.js';
import { isErrorText, stripNoticeMark } from './ui.jsx';
// 品牌标（学生画布左上角）。与 dsh 学生端用的是同一张图，见 deploy/dsh-student/assets/。
import brandLogo from './assets/lingdong-ai-logo.webp';
import { ErrorState, Loading, Notice, Empty, PageHeader } from './ui.jsx';   // Panel / Status 未使用（2026-09-26 审计）
import { useData } from './classroom.jsx';
import { errorText } from '@platform/shared';
// 画布「可提交产出」的判定与提交/保存互斥的闸门 —— 与服务端**同一份算法**
// （服务端直接 import packages/shared/src/canvasOutput.js，见 apps/server/src/routes/student.js）。
import { canvasOutputSignature, createSaveGate, hasUnsubmittedOutput, isCanvasEditableProjectStatus } from './canvasOutput.js';

/**
 * 「哪些框体能接收一条提示词（课堂素材里的提示词/文本）」。与 canvas/index.jsx 的 supportsPrompt
 * **同一份口径**：文字(prompt/text)、画面(image)、短片(video/animation)、音乐(music)、音频(audio)。
 * ⚠️ 2026-09-25：这份清单原来只有 text/image/video，音乐框体被漏掉 ——
 * 学生画布上摆着音乐框体、点提示词却被告知「没有可插入的未生成框体」（用户当场报的）。
 * 插入时写哪个字段：画面写 `caption`、其余写 `text`（见下面的 insertPromptToSlot，与 buildBoxNode 一致）。
 */
const PROMPT_SLOT_TYPES = ['text', 'prompt', 'image', 'video', 'animation', 'music', 'audio'];
/** 插入选择框里每个框体右边那行小字的动词（2026-09-25：原来只会写「生图 / 生视频」，音乐框体会被标成「生图」）。 */
const PROMPT_SLOT_ACTION = { text: '写文字', prompt: '写文字', image: '生图', video: '生视频', animation: '生动画', music: '生音乐', audio: '生音频' };

/**
 * 作品已发布到作品广场时，学生再点「提交作品」要说的话（2026-09-26）。
 * 只说"不允许重新提交"等于没说 —— 服务端状态机里 PUBLISHED 要**先下架**（→ UNPUBLISHED）才收新的提交，
 * 所以这句必须把"下一步找谁做什么"写出来，和 p148 那个「购买批次余额不足」是同一种口径：
 * 报错要能指着路，不能只挡人。
 */
const WORK_PUBLISHED_LOCK_MESSAGE = '这份作品已经发布到作品广场，不能再重新提交了。想接着补充内容：请老师或平台先在作品管理里把它「下架」，下架后这里就能继续提交。';

/**
 * 等一条生成任务出结果。
 *
 * 2026-09-30 用户口径（原话）：「除非上游真的报错，不然应该一直等到上游出结果。每个框体都一样。」
 * 这里原来写的是 `for (attempt < 150) { 等 2 秒; 查一次 }` = **5 分钟**上限，到点就抛
 * 「生成仍在进行中，请稍后刷新查看」—— 而生产实测一条 15 秒的视频上游跑了 **425 秒**，
 * 于是学生看到的就是"失败"（服务端那边还跟着在 5 分钟处把任务判死，两处正好一起砍）。
 *
 * 现在结束只有两种可能：任务 **SUCCEEDED** / **FAILED**（上游真报错时服务端把任务收成 FAILED 并带原因）。
 * 单次查询失败（网络抖一下、服务端正忙）**不算上游报错** → 忽略它、下一轮接着问；
 * 但要是**连着** 1 分钟一次都问不到，那就如实抛出去 —— 服务端整个不可用时，这个框体不该永远转圈。
 */
async function waitForGenerationJob(api, jobId) {
  const path = `ai/generations/history/${encodeURIComponent(jobId)}`;
  let missesInARow = 0;
  for (;;) {
    let job = null;
    try {
      // 单次查询自己带 30 秒超时：查询挂住时掐掉这一轮再问（与"等多久"无关）。
      job = await api.get(path, { timeoutMs: 30000 });
      missesInARow = 0;
    } catch (error) {
      // 任务记录都没了（换了账号 / 被清理）→ 再问也没有意义，如实抛给调用方。
      if (Number(error?.status) === 404) throw error;
      missesInARow += 1;
      if (missesInARow >= 30) throw error;
    }
    if (job && ['SUCCEEDED', 'FAILED'].includes(String(job.status))) return job;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// Signatures and helpers (原独立学生端逻辑，已并入官网学习页)
// 快照的「内容」用于判断有没有未保存改动。**必须包含节点位置**：
// 漏掉位置时，学生把框体挪来挪去不会算成改动 → 不触发自动保存 → 一刷新位置全复原（用户反馈过）。
// 只取会变且需要落库的字段：id/type/data/position；selected、measured 这类运行时状态不算改动。
function canvasContentSignature(snapshot) {
  if (!snapshot) return '';
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges : [];
  return JSON.stringify({
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      data: node.data || node.props || {},
      position: { x: Math.round(Number(node.position?.x) || 0), y: Math.round(Number(node.position?.y) || 0) },
    })),
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

// （MAX_CANVAS_IMPORT_BYTES 已随「画布导入校验」一起下线 —— 2026-09-26 审计删掉这个孤儿常量）

// 校验 exportVersion 产出的 JSON：{format, formatVersion, project, canvasSnapshot}

function mediaKindOfFile(file) {
  const mime = String(file?.type || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return '';
}

/**
 * @param prep 可选：**老师备课模式**（2026-09-30 用户口径「直接进入到画布课堂」）。
 *   传 `{ project, draftKey }` 时：
 *     · 项目/任务数据**不从学生接口取**，而是用注入的 `project`（机构端 `lessons/:id/prep` 那份，
 *       形状与 `student/projects/:id` 一致：canvasSnapshot / materialGroups / generationBoxes / capabilities）；
 *     · **不写服务器**：自动保存改成只写本机 `localStorage[draftKey]`（备课草稿，换设备就没了）；
 *     · **不生成**：不把 `generateCanvasNode` 交给画布 → 生成按钮自己就不渲染；
 *     · 不做"老师还在不在上课"的轮询、不提交作品（那三件事都是学生的）。
 *   ⚠️ 界面本身**一个字都不改**：老师看到的就是学生那套画布课堂。
 */
export function CanvasWorkspace({ api, prep = null, ...props }) {
  const navigate = useNavigate();
  const prepMode = Boolean(prep?.project);
  const prepDraftKey = String(prep?.draftKey || '');
  const paramsFromUrl = useParams(); const projectId = props?.params?.projectId || paramsFromUrl?.projectId;
  const project = useData(
    () => (prepMode ? Promise.resolve(prep.project) : api.get(`student/projects/${projectId}`)),
    [api, projectId, prepMode, prep?.project],
  );
  const generations = useData(
    () => (prepMode ? Promise.resolve({ items: [] }) : api.get(`ai/generations?projectId=${encodeURIComponent(projectId)}`)),
    [api, projectId, prepMode],
  );
  const [draft, setDraft] = useState(null);
  const [canvasSnapshot, setCanvasSnapshot] = useState(null);
  const [canvasVersion, setCanvasVersion] = useState(0);
  const [savedSignature, setSavedSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [canvasRevision, setCanvasRevision] = useState(0);
  const [message, setMessage] = useState('');
  // ⚠️ 用户口径 2026-09-18 晚：「画布课堂右下角这个提示必须要移除，很挡视野」。
  // 那个提示就是下面渲染的 `.cv-toast`（`position:fixed; right:18px; bottom:18px`）。
  // 它原来**一旦出现就一直挂着**（要等下一次操作把它覆盖掉）—— 比如
  // 「已添加「X」，请填写提示词或从素材插入。」说完就没人再去清它，于是那条横幅长期挡住画布右下角。
  // 现在的口径：**非错误的提示 5 秒后自动消失**；带「失败 / 错误」的留着（出错信息不该自己溜走）。
  useEffect(() => {
    if (!message) return undefined;
    // 错误提示（`errorText` 带了标记）留着不走；其它 5 秒自动消失（口径见 §二.O）。
    if (isErrorText(message)) return undefined;
    const timer = setTimeout(() => setMessage(''), 5000);
    return () => clearTimeout(timer);
  }, [message]);
  const [generationForm, setGenerationForm] = useState({ modality: 'IMAGE', prompt: '', title: '' });
  const [generating, setGenerating] = useState(false);
  const [toolPanel, setToolPanel] = useState(null);
  const [promptTarget, setPromptTarget] = useState(null);
  // 顶栏要显示「这是谁的画布」：登录时把用户写进了会话（登录响应里的 user），读一次就够。
  // 读不到就退回占位文案，不能让顶栏空着。
  // ⚠️ 必须放在这一堆 hook 里（下面有「hook 全部调用完毕才可以提前返回」那条线）——
  //    写到提前 return 之后，一走到那个分支 hook 数量就变了，React 直接崩（p34 抓过）。
  const [studentName] = useState(() => {
    try {
      const session = readSession();
      return String(session?.user?.displayName || session?.user?.login || '').trim();
    } catch { return ''; }
  });
  // 受鉴权保护的素材（/api/**）要带 token 取回来转成 blob: 才能给 <img>/<video> 用
  // （那两个标签发不出 Authorization 头）。同一个地址只取一次。
  // ⚠️ 必须放在所有提前 return 之前（p34 守卫盯着这条：hook 写在 return 之后会整页白屏）。
  const assetBlobCache = useRef(new Map());
  const resolveAssetUrl = useCallback((url) => {
    const target = String(url || '');
    if (!target.startsWith('/api/')) return Promise.resolve(target);
    if (assetBlobCache.current.has(target)) return assetBlobCache.current.get(target);
    const pending = api.fetchBlobUrl(target).catch(() => '');
    assetBlobCache.current.set(target, pending);
    return pending;
  }, [api]);
  // 素材面板点「已在画布上」的框体时，让画布把对应节点选中并居中（见 CanvasEditor 的 focusRequest）
  const [focusRequest, setFocusRequest] = useState(null);
  // 只供侧栏新增使用：由画布按实时视角计算中心，绝不把入场状态写进快照。
  const placementRef = useRef(null);
  const placementCountRef = useRef(0);
  const [entranceRequest, setEntranceRequest] = useState(null);
  useEffect(() => {
    if (!entranceRequest) return undefined;
    const timer = setTimeout(() => setEntranceRequest(null), 600);
    return () => clearTimeout(timer);
  }, [entranceRequest]);
  // 左侧工具栏面板是否收起（参考 ASUI Canvas 的可收起侧栏）
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (!project.data) return;
    const snapshot = project.data.canvasSnapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    setCanvasSnapshot(snapshot);
    setCanvasVersion(project.data.latestVersion);
    setDraft(snapshot);
    setSavedSignature(canvasContentSignature(snapshot));
  }, [project.data?.id, project.data?.latestVersion]);



  // ⚠️ 提前 return 之前不能再出现 hook：加载态与就绪态渲染的 hook 数量必须一致，
  // 否则 React 抛 #310 整页白屏（本轮自动保存 hook 曾放在 return 之后，画布课堂直接打不开）。
  //
  // ⚠️ 2026-09-24 用户口径（画布「增量提交」）：**提交之后画布不锁** ——
  //    「点击后作品提交到后台，学生仍可继续编辑尚未操作的任务」。
  //    所以这里从"只认 DRAFT"改成 DRAFT/SUBMITTED 都算能编辑（见 canvasOutput.js 的
  //    isCanvasEditableProjectStatus）；课堂一结束服务端就会拒保存/拒生成，客户端另有
  //    session-state 轮询把学生带回课程中心。
  const editable = Boolean(project.data) && isCanvasEditableProjectStatus(project.data.status);
  const changed = draft && canvasContentSignature(draft) !== savedSignature;
  // 上一次**提交成功**时的产出指纹（来自服务端；提交成功后本地也会立即更新一次）。
  const [submittedSignature, setSubmittedSignature] = useState('');
  useEffect(() => {
    setSubmittedSignature(String(project.data?.lastSubmittedOutputSignature || ''));
  }, [project.data?.id, project.data?.lastSubmittedOutputSignature]);
  // 「可提交产出」：相对上一次提交，画布上还有没有**新的产出**（提交按钮的激活判据）。
  // 只有改提示词 / 挪框体 / 连线变化 / 空占位框体都不算（口径见 canvasOutput.js）。
  const hasSubmittableOutput = hasUnsubmittedOutput(draft || canvasSnapshot || project.data?.canvasSnapshot || null, submittedSignature);
  // ⚠️ 「已发布到作品广场」的作品**不能再重新提交**（2026-09-26 现场：平台端点了「发布到官网」之后，
  //    学生这边按钮还亮着、点下去只弹一句「当前作品状态不允许重新提交」—— 学生不知道自己在等什么，
  //    连着点了 6 次）。服务端状态机里 `PUBLISHED → PENDING` 不是合法转换
  //    （`PENDING / APPROVED / REJECTED / UNPUBLISHED` 都可以），所以这一档得在按钮上就拦住。
  //    判据直接取项目载荷里的 `workStatus`（`normalizeProject` 一路带着 work.id/status）。
  //    要接着提交：请老师/平台先在作品管理里把它**下架**（→ UNPUBLISHED，那个状态可以再提交）。
  const workPublished = String(project.data?.workStatus || '') === 'PUBLISHED';

  // 服务端任务（刷新后仍在）：每个框体最多保留最新一条。恢复逻辑与素材面板都要用，所以一并放在 hook 之前。
  const generationJobs = Array.isArray(generations.data?.items) ? generations.data.items : [];
  const jobByBox = new Map();
  for (const job of generationJobs) {
    const boxId = String(job?.boxId || '');
    if (boxId && !jobByBox.has(boxId)) jobByBox.set(boxId, job);
  }
  const boxSucceeded = (boxId) => String(jobByBox.get(boxId)?.status || '') === 'SUCCEEDED';
  const boxRunning = (boxId) => ['QUEUED', 'RUNNING'].includes(String(jobByBox.get(boxId)?.status || ''));
  const runningCount = [...jobByBox.values()].filter((job) => ['QUEUED', 'RUNNING'].includes(String(job.status))).length;

  // 自动保存：改动停下来 1.2 秒就写回服务器（不递增版本号），刷新/断网不至于把画布丢光。
  const [autoSaving, setAutoSaving] = useState(false);
  // 自动保存失败必须让学生看见。之前这里是静默 catch（「不打扰学生」），结果线上出现过：
  // 作品所属课包被归档 → 保存接口一直 404 → 界面还显示「已保存」→ 刷新全丢。
  const [saveError, setSaveError] = useState('');
  const autoSaveRef = useRef({ signature: '', busy: false });
  // 提交与自动保存的互斥闸门：提交期间冻结新保存，并让**在途的旧保存响应**失效
  // （口径与三条规则见 canvasOutput.js 的 createSaveGate）。
  const saveGateRef = useRef(createSaveGate());
  // ⭐ 2026-09-28 用户报「拖动了很多外部文件进画布，删了又出现删了又出现」：
  //    上传是"几秒到几十秒"的异步过程，**这期间用户完全可以把刚拖进来的框体删掉**。
  //    原来 uploadFiles 把"上传开始那一刻的整份快照"存进 current、每传完一个就**整份写回** ——
  //    于是每个文件传完都会把用户删掉的那些框体一起带回来（6 个文件 = 反复回来 6 次）。
  //    现在的口径：**每次写回都基于"最新那份"快照，而且只 patch 这一个节点**
  //    （`patchNode` 对已经不在的节点什么都不做 → 删掉的就是删掉了）。
  // ⚠️ 这个 ref 与 commitCanvas 必须放在**所有提前 return 之前**（p34 钩子顺序守卫盯着）：
  //    下面有 `if (!project) return …` 之类的提前返回，hook 落在后面会抛 React #300 白屏。
  // ⚠️⚠️ 2026-09-28 生产事故（P0，学生进画布课堂**整页白屏**）：上面那句"挪到提前返回之前"——
  //    挪对了钩子顺序，却让这一行**在渲染期第一次就跑**，而那时 `project` 还在 loading
  //    （`useData` 初始态 `{loading:true, data:null}`），`project.data` 是 **null** →
  //    读 `.canvasSnapshot` 抛 `Cannot read properties of null (reading 'canvasSnapshot')`。
  //    下面的兜底字面量本来就是给"还没有数据"这一档准备的，所以这里必须用 **`?.`**。
  //    ⚠️ 改这一行别把 `?.` 去掉：这是"提前返回之前"的唯一一条约束，p39 盯着它。
  const latestCanvasRef = useRef(null);
  latestCanvasRef.current = draft || canvasSnapshot || project.data?.canvasSnapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const commitCanvas = (next) => {
    latestCanvasRef.current = next;
    setCanvasSnapshot(next); setDraft(next); setCanvasRevision((value) => value + 1);
  };
  // 备课模式：**不碰服务器**，改动停下来 0.8 秒写一份到本机（刷新不丢；不写任何学生的作品）。
  useEffect(() => {
    if (!prepMode || !prepDraftKey || !draft || !changed) return undefined;
    const timer = setTimeout(() => {
      try {
        window.localStorage.setItem(prepDraftKey, JSON.stringify(draft));
        setSavedSignature(canvasContentSignature(draft));
        setSaveError('');
      } catch { /* 存不下就只活在内存里 */ }
    }, 800);
    return () => clearTimeout(timer);
  }, [prepMode, prepDraftKey, draft, changed]);

  useEffect(() => {
    if (prepMode) return undefined;   // 备课没有"服务器上的项目"可存
    if (!editable || !draft || !changed) return undefined;
    const signature = canvasContentSignature(draft);
    const timer = setTimeout(async () => {
      if (autoSaveRef.current.busy || autoSaveRef.current.signature === signature) return;
      // 提交请求在途时不开始新的保存：这次保存会赶在提交之后落库、把刚提交的快照覆盖回旧值。
      if (saveGateRef.current.frozen) return;
      const token = saveGateRef.current.currentToken();
      autoSaveRef.current.busy = true;
      setAutoSaving(true);
      try {
        const saved = await api.put(`student/projects/${project.data.id}`, { canvasSnapshot: draft, autoSave: true });
        // 提交已经发生（token 变了）→ 这次响应是**在途的旧结果**，整个丢掉：
        // 既不能把旧快照写回界面，更不能把「已保存指纹」覆盖成提交前的那一个。
        if (!saveGateRef.current.isCurrent(token)) return;
        autoSaveRef.current.signature = canvasContentSignature(saved.canvasSnapshot);
        setCanvasSnapshot(saved.canvasSnapshot);
        setSavedSignature(canvasContentSignature(saved.canvasSnapshot));
        setSaveError('');
      } catch (error) {
        if (!saveGateRef.current.isCurrent(token)) return;
        setSaveError(error?.message || '保存失败，请稍后重试');
      }
      finally { autoSaveRef.current.busy = false; setAutoSaving(false); }
    }, 1200);
    return () => clearTimeout(timer);
  }, [api, changed, draft, editable, project.data?.id]);

  // 把服务端任务产出的素材挂到节点数据上：文字挂文本，图片/视频/音乐挂地址。
  function assetNodeData(nodeData, asset) {
    if (!asset) return {};
    if (String(nodeData?.slotType || '') === 'text') return { generatedText: String(asset.metadata?.text || asset.text || '') };
    const url = String(asset.assetUrl || '');
    return url ? { assetUrl: url, previewUrl: String(asset.previewUrl || '') || url } : {};
  }

  // 对齐生成状态：服务端任务有结果的框体，既要把缺失的节点补回画布，
  // 也要**就地更新已经在画布上的节点**——生成期间刷新过页面的话，节点会停在「AI生成中…」，
  // 之前只补节点不更新，任务早就成功了节点也永远不变（学生反馈：等了十多分钟还在「AI生成中」）。
  useEffect(() => {
    if (!editable || !project.data || !generations.data) return undefined;
    const boxes = Array.isArray(project.data.generationBoxes) ? project.data.generationBoxes : [];
    if (!boxes.length) return undefined;
    const current = draft || canvasSnapshot || project.data.canvasSnapshot;
    if (!current) return undefined;
    const boxIds = new Set(boxes.map((box) => box.id));
    const onCanvas = new Set();
    let touched = false;
    const nodes = (current.nodes || []).map((node) => {
      const boxId = String(node.data?.boxId || '');
      if (!boxId || !boxIds.has(boxId)) return node;
      onCanvas.add(boxId);
      const job = jobByBox.get(boxId);
      if (!job) return node;
      const status = String(job.status || '');
      const asset = Array.isArray(job.assets) ? job.assets[0] : null;
      // 已完成：把结果挂上去（已经有结果的节点不覆盖，避免把学生后来生成的成果换掉）
      if (status === 'SUCCEEDED' && asset && !node.data.assetUrl && !node.data.generatedText) {
        touched = true;
        return { ...node, data: { ...node.data, ...assetNodeData(node.data, asset), generationStatus: null, generationError: '' } };
      }
      // 已失败：把「生成中」翻成失败并带上原因
      if (status === 'FAILED' && node.data.generationStatus === 'PENDING') {
        touched = true;
        return { ...node, data: { ...node.data, generationStatus: 'FAILED', generationError: job.errorMessage || '生成失败' } };
      }
      return node;
    });
    const missing = boxes.filter((box) => jobByBox.has(box.id) && !onCanvas.has(box.id));
    let next = touched ? { ...current, nodes } : current;
    for (const box of missing) {
      const job = jobByBox.get(box.id);
      const succeeded = String(job.status) === 'SUCCEEDED';
      next = { ...next, nodes: [...(next.nodes || []), buildBoxNode(box, next, { asset: succeeded ? job.assets?.[0] : null, pending: !succeeded })] };
    }
    if (!touched && !missing.length) return undefined;
    setCanvasSnapshot(next); setDraft(next);
    // 画布组件内部自己维护节点状态，只有重挂（key 变化）才会读到改过的快照——
    // 补节点和就地更新都要递增 canvasRevision，否则库里已经是「已完成」，界面还停在「AI生成中」。
    setCanvasRevision((value) => value + 1);
    return undefined;
  }, [canvasSnapshot, draft, editable, generations.data, project.data]);

  // 还有任务在跑就轮询，跑完的结果会自动补到画布上。
  // 依赖只留 runningCount：useData 每次渲染返回新对象，放进 deps 会让 5 秒定时器被反复重置。
  useEffect(() => {
    if (!runningCount) return undefined;
    const timer = setInterval(() => generations.refresh(), 5000);
    return () => clearInterval(timer);
  }, [runningCount]);

  // 盯着「老师还在不在上课」（用户 2026-09-21 口径：**老师一点结束课堂，学生端就该退出画布、
  // 跳转回课程中心**）。每 10 秒问一次极小接口；一旦不是 ACTIVE 就提示一句再回课程中心。
  // ⚠️ 只认服务端的 `active`：没绑定课堂的老项目服务端按"还在上课"处理（不该把人踢出去）。
  useEffect(() => {
    if (prepMode) return undefined;   // 备课模式没有课堂可结束（老师点开的就是自己的备课画布）
    let stopped = false;
    let leaveTimer = null;
    async function checkSession() {
      try {
        const state = await api.get(`student/projects/${projectId}/session-state`);
        if (stopped || state?.active !== false) return;
        stopped = true;
        clearInterval(timer);
        setMessage(state.endedReason ? `老师已结束课堂（${state.endedReason}），正在回到课程中心…` : '老师已结束课堂，正在回到课程中心…');
        // 让提示停留一下再跳（1.6 秒），别让学生以为页面自己崩了。
        leaveTimer = setTimeout(() => navigate('/learn'), 1600);
      } catch { /* 轮询失败不当回事：下一次再问（网络抖一下就退出课堂反而更糟） */ }
    }
    const timer = setInterval(checkSession, 10000);
    return () => { stopped = true; clearInterval(timer); if (leaveTimer) clearTimeout(leaveTimer); };
  }, [api, projectId, navigate]);

  // 到这里 hook 全部调用完毕，才可以提前返回。
  if (project.loading) return <Loading label="正在打开魔法画布…" />;
  if (project.error) return <ErrorState error={project.error} onRetry={project.refresh} />;







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
    const { position, viewport } = sidebarPlacement(type);
    const next = { ...current, viewport: viewport || current.viewport, nodes: [...(current.nodes || []), { id: nodeId, type, position, data }] };
    setCanvasSnapshot(next); setDraft(next); setEntranceRequest({ id: nodeId }); setCanvasRevision((value) => value + 1);
  }

  async function generateCanvasNode({ modality, prompt, title, sourceAssetUrl = '', lastFrameAssetUrl = '', referenceAssets = [], boxId = '', params = null }) {
    if (!editable) throw new Error('当前作品不可编辑');
    // 比例/清晰度/时长/音频：框体定了的以框体为准，框体留空的用学生在画布上选的值
    // （params 里就是学生选的；服务端仍会按模型能力再校验一次）。
    const queued = await api.post('ai/generations/async', { projectId: project.data.id, modality, prompt, title, sourceAssetUrl, lastFrameAssetUrl, referenceAssets, boxId, ...(params || {}) });
    const result = await waitForGenerationJob(api, queued.job.id);
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
      const result = await waitForGenerationJob(api, queued.job.id);
      if (result.status !== 'SUCCEEDED') throw new Error(result.errorMessage || '生成仍在进行中，请稍后刷新查看');
      const asset = result.assets?.[0];
      if (asset) addGeneratedAsset(asset, generationForm.prompt, generationForm.modality);
      setGenerationForm((current) => ({ ...current, prompt: '', title: '' }));
      setMessage(`已完成 ${result.modality} 素材生成，并已添加到未保存画布。`);
      generations.refresh();
    } catch (err) { setMessage(errorText(err)); }
    finally { setGenerating(false); }
  }


  async function submitWork() {
    if (!editable || !draft) return;
    // 按钮已经按它置灰了，这里再挡一次：键盘/脚本触发也走同一条判据。
    // 「已发布」排在最前：这时"有没有新产出"已经不是重点了，得先说清"为什么这次提交不了"。
    if (workPublished) { setMessage(WORK_PUBLISHED_LOCK_MESSAGE); return; }
    if (!hasSubmittableOutput) { setMessage('画布上还没有新的作品产出：先完成一张图/一段文字，或上传成品，再提交给老师。'); return; }
    if (!window.confirm('提交给老师前请确认：这是你自己的作品，并同意平台在作品广场展示。')) return;
    setBusy(true);
    // ① 冻结自动保存、② 让在途的旧保存响应全部失效（见 createSaveGate）；提交结束再放行。
    saveGateRef.current.beginSubmit();
    try {
      const result = await api.post(`student/projects/${project.data.id}/submit`, { canvasSnapshot: draft, description: `完成${project.data.courseLessonTitle || '本节课堂'}作品`, copyrightConfirmed: true });
      setCanvasSnapshot(result.project.canvasSnapshot);
      setDraft(result.project.canvasSnapshot);
      setSavedSignature(canvasContentSignature(result.project.canvasSnapshot));
      // 本地立刻记下这次提交的产出指纹（按钮马上回到置灰态），随后 project.refresh() 以服务端为准。
      setSubmittedSignature(String(result.project.lastSubmittedOutputSignature || canvasOutputSignature(result.project.canvasSnapshot)));
      setMessage('作品已提交，老师可以看到你的课堂作品了。还能继续做没做完的任务，做出新产出后再点一次「提交作品」。');
      project.refresh();
      // ⚠️ 2026-09-21 用户口径：**提交后不要自动跳走** —— 「老师如果没点结束课堂，应该留在原页面」。
      //    2026-09-24 追加：画布**也不再变成只读**（学生要能接着做剩下的任务）；
      //    老师一结束课堂，下面那个轮询会把全班带回课程中心。
    } catch (err) { setMessage(errorText(err)); }
    finally { saveGateRef.current.endSubmit(); setBusy(false); }
  }


  // 从桌面拖进来的图片/视频/音频。
  // ⚠️ 占位框体必须由**这一层**落：画布组件里的 setNodes 只是它自己的局部状态，快照里没有，
  //    上传完一刷新快照就被冲掉（第一版就是这么错的，拖进去什么都没发生）。
  // 流程：① 立刻把「上传中」的框体写进快照（用户要的是拖进去马上看得见）；
  //      ② 逐个上传，把**同一个节点**补成真素材（地址 + uploaded 标记）；
  //      ③ 这些文件同时出现在左侧「本地素材」里，可以连线给视频框体当首帧 / 全能参考素材。
  const patchNode = (snapshot, nodeId, data) => ({
    ...snapshot,
    nodes: (snapshot.nodes || []).map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node)),
  });
  async function uploadFiles(files, position) {
    if (!editable) { setMessage('课堂已结束，不能再修改画布。'); return; }
    const seed = Date.now().toString(36);
    const items = [...(files || [])].map((file, index) => ({ file, id: `upload-${seed}-${index}` }));
    const base = latestCanvasRef.current;
    // ① 先落占位框体（只有能识别的类型才落，别的交给下面逐个提示「已跳过」）
    const placeholders = items
      .map((item, index) => ({ ...item, kind: mediaKindOfFile(item.file), index }))
      .filter((item) => item.kind);
    commitCanvas({ ...base, nodes: [...(base.nodes || []), ...placeholders.map((item) => ({
      id: item.id,
      type: item.kind,
      position: { x: (position?.x || 200) + item.index * 40, y: (position?.y || 160) + item.index * 30 },
      data: { title: item.file.name, uploading: true, caption: '', text: '' },
    }))] });
    setMessage(placeholders.length ? `正在上传 ${placeholders.length} 个文件…` : '这些文件不是图片/视频/音频，已跳过（支持 jpg/png/webp/gif、mp4/webm、mp3/wav/ogg）。');
    // ② 逐个上传
    let placed = 0;
    for (const item of items) {
      if (!mediaKindOfFile(item.file)) { setMessage(`「${item.file.name}」不是图片/视频/音频，已跳过（支持 jpg/png/webp/gif、mp4/webm、mp3/wav/ogg）。`); continue; }
      try {
        setMessage(`正在上传「${item.file.name}」…`);
        const asset = await api.upload('student/file-assets/upload', item.file, { category: 'MEDIA_ASSET', visibility: 'PRIVATE' });
        const url = String(asset?.proxyRoute || asset?.storageUrl || '');
        if (!url) throw new Error('上传后没有拿到文件地址');
        // ⚠️ 用 latestCanvasRef.current（此刻最新的那份）而不是循环外那份底座
        commitCanvas(patchNode(latestCanvasRef.current, item.id, {
          title: item.file.name, caption: '', text: '',
          assetUrl: url, previewUrl: url, uploading: false,
          uploaded: true, fileAssetId: asset.id || null, mimeType: asset.mimeType || String(item.file.type || ''),
        }));
        placed += 1;
      } catch (error) {
        // 上传失败：撤掉「上传中」并在框体上写明原因（不让它一直转、也不静默吞掉）
        commitCanvas(patchNode(latestCanvasRef.current, item.id, { uploading: false, uploadError: error.message }));
        setMessage(`「${item.file.name}」上传失败：${error.message}`);
      }
    }
    if (placed) setMessage(`已把 ${placed} 个文件放进画布，左侧「本地素材」里也能找到它们。`);
  }

  function sidebarPlacement(type) {
    const offset = placementCountRef.current++ % 5;
    const placed = placementRef.current?.(type, offset);
    if (!placed) return { position: { x: 160 + offset * 36, y: 120 + offset * 26 }, viewport: null };
    return placed;
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
    const { position, viewport } = sidebarPlacement(type);
    const node = {
      id: `lesson-material-${material.id}-${Date.now().toString(36)}`,
      type,
      position,
      data: { ...fallbackData, ...sourceData, ...mediaData, title: material.title || sourceData.title, lessonMaterialId: material.id, isLessonMaterial: true },
    };
    const next = { ...current, viewport: viewport || current.viewport, nodes: [...(current.nodes || []), node] };
    setCanvasSnapshot(next); setDraft(next); setEntranceRequest({ id: node.id }); setCanvasRevision((value) => value + 1);
    setMessage(`已将“${material.title || '课堂素材'}”加入画布。`);
  }

  const generationBoxes = Array.isArray(project.data.generationBoxes) ? project.data.generationBoxes : [];
  // 本课**配了哪些模态的生成框体**（大写模态值）。画布面板用它判断"这个节点到底能不能生成"：
  // 本课有该模态的框体、而节点没有 boxId → 点了必然被服务端拒（GENERATION_BOX_REQUIRED），
  // 那就干脆不显示生成按钮（用户 2026-09-21：「本来就不能生成就不要显示这个按钮了」）。
  const boxModalities = [...new Set(generationBoxes.map((box) => String(box.modality || '').toUpperCase()).filter(Boolean))];

  function boxNodes() {
    const current = draft || canvasSnapshot || project.data.canvasSnapshot || { nodes: [] };
    return (current.nodes || []).filter((node) => node.data?.boxId);
  }

  // 服务端任务的整理见上方 hook 之前，这里只做框体使用状态判断。
  function boxOnCanvas(boxId) { return boxNodes().some((node) => node.data.boxId === boxId); }

  // 框体素材的配置存在 snapshot.box 里；服务端下发的 generationBoxes 是同一份数据的摊平视图。
  function boxForMaterial(material) {
    const fromServer = generationBoxes.find((box) => box.id === material.id);
    if (fromServer) return fromServer;
    const raw = material.snapshot?.box && typeof material.snapshot.box === 'object' ? material.snapshot.box : {};
    return {
      id: material.id, title: material.title,
      modality: String(raw.modality || '').toUpperCase(), model: raw.model || '',
      // ⚠️ 手工重建这条路**也要带上显示名**（服务端给 material.snapshot.box 打了 modelLabel）：
      //    这条路走的是"生成框体清单里没有它"的兜底（老课包/预览场景），漏一行就成了
      //    "画布上写着中文名、左侧素材面板却还写着 deepseek-flash"（2026-09-23 真浏览器核验抓到的就是它）。
      modelLabel: raw.modelLabel || '',
      aspectRatio: raw.aspectRatio || '', resolution: raw.resolution || '',
      // ⚠️ 2026-09-26 全站审计：音频是**三态** —— null＝学生自选 / true·false＝课包定了
      //    （见 buildBoxNode 里那条注释）。这里原来把"没配"写成 false，于是老课包兜底出来的
      //    框体被当成"课包定了不含音频" → 面板藏掉音频选择器、请求里硬发 audio:false。
      durationSeconds: Number.isInteger(Number(raw.durationSeconds)) && Number(raw.durationSeconds) > 0 ? Number(raw.durationSeconds) : null,
      audio: raw.audio === true ? true : raw.audio === false ? false : null,
      // 本节课锁定的生成方式（'' = 不锁）—— 列表里没有该框体时要自己拼，别漏（漏了画布就按模型自由发挥）
      inputMode: String(raw.inputMode || '').toUpperCase(), inputModeLabel: raw.inputModeLabel || '',
      // 课包锁的「音频怎么用」：漏了它会退回"对口型"（默认），与课包配的就不一致了
      audioRole: String(raw.audioRole || 'LIP_SYNC').toUpperCase() === 'VOICE_REFERENCE' ? 'VOICE_REFERENCE' : 'LIP_SYNC',
      audioRoleLabel: raw.audioRoleLabel || '',
      prompt: material.snapshot?.content || '', assetUrl: material.assetUrl || '',
    };
  }

  // 素材面板的参数行与「框体 → 画布节点」都在 `canvasBoxNode.js` 一份实现里（备课画布也 import 它）。
  // ⚠️ 别再往这里加第二份：抄一份出来的那天起，学生画布与备课画布就会开始漂。

  function addBoxToCanvas(box) {
    if (!editable) { setMessage('课堂已结束，不能再修改画布。'); return; }
    const slotType = String(box.modality || '').toLowerCase();
    const current = draft || canvasSnapshot || project.data.canvasSnapshot || { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const existing = (current.nodes || []).find((node) => node.id === `box-${box.id}` || node.data?.boxId === box.id);
    // 已经在画布上的框体不再重复添加（一个框体只对应一个节点），改成选中并定位过去：
    // 学生点了必须看得见反应，否则就像按钮坏了。
    // 已经在画布上：直接把视图定位过去就好。**不再弹那句提示**
    // （用户 2026-09-17 口径：「素材1」已经在画布上了…这句删掉）—— 定位本身就是反馈。
    if (existing) { setFocusRequest({ id: existing.id, token: Date.now() }); return; }
    // 能力未开放时也不允许加框体，避免出现学生无法生成的空框体。
    if (!(Array.isArray(project.data.capabilities) ? project.data.capabilities : ['text']).includes(slotType)) { setMessage('本课未开放该 AI 能力。'); return; }
    // 服务端已经有这个框体的任务、画布上却没有节点（例如恢复过历史版本）：把结果或「生成中」状态一起接回来。
    const job = jobByBox.get(box.id);
    const succeeded = String(job?.status || '') === 'SUCCEEDED';
    const node = buildBoxNode(box, current, { asset: succeeded ? job.assets?.[0] : null, pending: Boolean(job) && !succeeded });
    const { position, viewport } = sidebarPlacement(node.type);
    const next = { ...current, viewport: viewport || current.viewport, nodes: [...(current.nodes || []), { ...node, position }] };
    setCanvasSnapshot(next); setDraft(next); setEntranceRequest({ id: node.id }); setCanvasRevision((value) => value + 1);
    setMessage(job ? `已把「${box.title}」接回画布。` : `已添加「${box.title}」，请填写提示词或从素材插入。`);
  }

  function openPromptInsert(material) {
    if (!editable) return;
    const targets = boxNodes().filter((node) => {
      // ⚠️ 2026-09-25 用户报：「画布课堂提示词无法添加到音乐框体吗？」
      //    这里原来写死 ['text','image','video'] —— 音乐（music）与音频/动画框体被漏掉了：
      //    画布上明明摆着一个还没生成的音乐框体，点提示词却提示「画布上没有可插入的未生成框体」。
      //    判据改成**与"哪些框体能写提示词"同一份清单**（见 canvas/index.jsx 的 supportsPrompt）。
      if (!PROMPT_SLOT_TYPES.includes(String(node.data?.slotType || ''))) return false;
      return !boxSucceeded(node.data.boxId) && !node.data.generatedText && !node.data.assetUrl;
    });
    if (!targets.length) { setMessage('画布上没有可插入的未生成框体，请先从「生成框体」添加。'); return; }
    setPromptTarget({ material, targets });
  }

  function insertPromptToSlot(nodeId) {
    const material = promptTarget?.material;
    if (!material || !nodeId) return;
    const text = material.snapshot?.content || material.description || material.title || '';
    const current = draft || canvasSnapshot || project.data.canvasSnapshot;
    if (!current) return;
    const target = (current.nodes || []).find((node) => node.id === nodeId);
    if (!target || boxSucceeded(target.data?.boxId) || target.data?.generatedText || target.data?.assetUrl) {
      setPromptTarget(null);
      setMessage('这个框体已生成，不能再插入提示词。');
      return;
    }
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
  // 本地素材 = 学生从桌面拖进画布的那些文件（画布节点上带 uploaded 标记）。
  // 直接从快照派生：拖进去的框体一出现（哪怕还在「上传中」）这里就有一份，不需要额外的服务端状态。
  const localMaterials = ((draft || canvasSnapshot || project.data.canvasSnapshot)?.nodes || [])
    .filter((node) => node.data?.uploaded === true || node.data?.uploading === true)
    .map((node) => ({
      id: node.id,
      title: node.data?.title || '本地素材',
      kind: node.type === 'video' ? '视频' : node.type === 'audio' ? '音频' : '图片',
      uploading: node.data?.uploading === true,
      fileAssetId: node.data?.fileAssetId || null,
    }));
  const capabilities = Array.isArray(project.data.capabilities) && project.data.capabilities.length ? project.data.capabilities : ['text'];
  // 当前展开的大分组：导航项的 key 就是 `group:<id 或下标>`
  const activeGroupIndex = typeof toolPanel === 'string' && toolPanel.startsWith('group:')
    ? materialGroups.findIndex((group, index) => `group:${group.id || index}` === toolPanel)
    : -1;
  const activeGroup = activeGroupIndex >= 0 ? materialGroups[activeGroupIndex] : null;
  // 画布面板上那个「✦ 生图 · 1k · …」的配置芯片点进来时：优先打开**有生成框体**的那一组，
  // 没有就打开第一组（以前是打开笼统的「素材」面板，现在没有那一层了）。
  const openMaterialsPanel = () => {
    setSidebarCollapsed(false);
    const index = materialGroups.findIndex((group) => (group.materials || []).some((item) => item.materialType === 'GENERATION_BOX'));
    const target = index >= 0 ? index : 0;
    setToolPanel(materialGroups.length ? `group:${materialGroups[target].id || target}` : 'materials');
  };

  return <main className="cv-shell">
    <header className="cv-topbar">
      {/* 左上角：灵动ai 的标 + 这位学生自己的账号名（用户 2026-09-17 口径：
          原来那个「✦ AI 魔法学院 / 学生创作画布」换成品牌 logo，logo 下方显示学生名字）。 */}
      {/* 用户 2026-09-17 再调：名字放在 logo **右边**（放下面太挤），白色更显眼，
          格式是「同学：xxx」。 */}
      <div className="cv-brand">
        <img className="cv-brand__logo" src={brandLogo} alt="灵动ai" />
        <small className="cv-brand__name" title="当前登录的账号">{studentName ? `同学：${studentName}` : '同学'}</small>
      </div>
      <div className="cv-toptitle">{prepMode
        ? <><span>备课模式 · 不生成</span><strong>{lessonTitle}</strong></>
        : <><span>正在上课</span><strong>{lessonTitle}</strong></>}

      </div>
      {prepMode ? <div className="cv-actions">
        {/* 备课模式：**没有"保存到服务器"这件事**（草稿在本机），也没有"提交作品"。
            顶栏只留一个能回到课时详情的出口 —— 其余仍与学生画布一模一样。 */}
        <span className="cv-save-state" title="备课草稿只保存在这台电脑上">{changed ? '草稿已存本机' : '备课草稿'}</span>
        <button type="button" className="cv-btn" onClick={() => navigate('/org/courses')}>返回课程备课</button>
      </div> : <div className="cv-actions">
        <span
          className={`cv-save-state ${saveError ? 'is-error' : changed ? 'is-dirty' : ''}`}
          title={saveError ? `保存失败：${saveError}（改动还没写进服务器，先别刷新；请把这条信息发给老师）` : undefined}
        >{saveError ? `保存失败：${saveError}` : changed ? (autoSaving ? '自动保存中…' : '有未保存修改') : '已保存'}</span>
        {/* ⚠️ 2026-09-21 用户口径：这里原来跳 `/learn/canvas`（「画布上课」那个**旧页面**）——
            现在跳**课程中心**（`/learn`，学生端保留的那一版），并跟着改叫「课程中心」，
            和"老师结束课堂后回到课程中心"是同一个落点。 */}
        <button type="button" className="cv-btn" onClick={() => navigate('/learn')}>课程中心</button>
        {/* 「已发布」要排在「有没有新产出」前面：否则学生看到的是"按钮亮着、点下去说做完了再说"——
            这次的问题是反过来的（有产出、但作品已发布），两句话都会把人绕进去。 */}
        <button type="button" className="cv-btn cv-btn--primary" disabled={!editable || busy || !draft || !hasSubmittableOutput || workPublished} title={workPublished ? WORK_PUBLISHED_LOCK_MESSAGE : hasSubmittableOutput ? '把这次做出来的作品提交给老师' : '画布上还没有作品产出：先生成图片/文字或上传成品，做好后按钮会亮起来'} onClick={submitWork}>{busy ? '提交中…' : '提交作品'}</button>
      </div>}
    </header>
    <section className="cv-layout">
      <aside className={`cv-sidebar ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
        <div className="cv-sidebar__head">
          <div className="cv-sidebar__title"><i><Icon name="menu" size={13} /></i><strong>工具</strong></div>
          <button type="button" className="cv-sidebar__toggle" aria-label={sidebarCollapsed ? '展开工具' : '收起工具'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? '展开工具' : '收起工具'} onClick={() => setSidebarCollapsed((value) => !value)}><Icon name="sidebar" size={15} /></button>
        </div>
        <div className="cv-nav">
          {/* 导航就是**大分组本身**（用户 2026-09-17 口径：取消「素材」这一层大类 ——
              以前是「素材」里再叠「图片模块 / 提示词模块 …」，素材一多就得在一个长列表里滚着找）。
              现在点哪个分组只看哪个分组的素材，列表短、一眼到底。 */}
          {materialGroups.map((group, index) => {
            const key = `group:${group.id || index}`;
            const count = (group.materials || []).length;
            return <button key={key} type="button" className={`cv-nav-item ${toolPanel === key ? 'is-active' : ''}`} title={`${group.title || `素材组 ${index + 1}`}（${count} 个）`} onClick={() => { setSidebarCollapsed(false); setToolPanel((value) => (value === key ? null : key)); }}><i><Icon name="grid" size={15} /></i><span>{group.title || `素材组 ${index + 1}`}</span></button>;
          })}
          {localMaterials.length ? <button type="button" className={`cv-nav-item ${toolPanel === 'local' ? 'is-active' : ''}`} title={`本地素材（${localMaterials.length} 个）`} onClick={() => { setSidebarCollapsed(false); setToolPanel((value) => (value === 'local' ? null : value)); }}><i><Icon name="upload" size={15} /></i><span>本地素材</span></button> : null}
          {materialGroups.length ? null : <button type="button" className={`cv-nav-item ${toolPanel === 'materials' ? 'is-active' : ''}`} title="课堂素材" onClick={() => { setSidebarCollapsed(false); setToolPanel((value) => (value === 'materials' ? null : value)); }}><i><Icon name="grid" size={15} /></i><span>课堂素材</span></button>}
          <button type="button" className={`cv-nav-item ${toolPanel === 'capabilities' ? 'is-active' : ''}`} title="能力" onClick={() => { setSidebarCollapsed(false); setToolPanel((value) => (value === 'capabilities' ? null : value)); }}><i><Icon name="sliders" size={15} /></i><span>能力</span></button>
        </div>
        {toolPanel && !sidebarCollapsed ? <div className="cv-panel">
          {activeGroup ? <>
            <div className="cv-panel__head"><div><strong>{activeGroup.title || `素材组 ${activeGroupIndex + 1}`}</strong><small>{editable ? '点框体或素材加入画布' : '课堂已结束，不能再修改画布'}</small></div><button type="button" className="cv-sidebar__close" onClick={() => setToolPanel(null)}><Icon name="close" size={14} /></button></div>
            <div className="cv-group">
              {(activeGroup.materials || []).map((material) => {
                const box = material.materialType === 'GENERATION_BOX' ? boxForMaterial(material) : null;
                // 素材类型决定图标与色调（与画布上框体那套蓝 / 紫 / 粉一致），
                // 于是一眼能分出这是生图框体、生视频框体还是生音乐框体（用户 2026-09-17 报的第 2 条）。
                const visual = materialVisual({ materialType: material.materialType, modality: box?.modality });
                if (box) {
                  const slotType = String(box.modality || '').toLowerCase();
                  const enabled = capabilities.includes(slotType);
                  const running = boxRunning(box.id);
                  const onCanvas = boxOnCanvas(box.id);
                  const blocked = !editable ? '课堂已结束，不能再修改画布' : (!enabled ? '本课未开放该 AI 能力' : '');
                  const state = onCanvas ? '已在画布上' : (running ? '生成中…' : (boxSucceeded(box.id) ? '已生成，点击接回画布' : '未生成'));
                  // ⭐ 生成框体带一圈金色（.is-gen-box，样式在 shared/styles.css）：
                  //    用户 2026-09-21 口径「生成框体都要有四周边环绕的金色，一眼就知道这是生成框体、
                  //    不是别的素材；只需要区分生成框体即可」。所以只加描边，不动图标那套模态色
                  //    （生图/生视频/生音乐的区分仍在，见 materialVisual）。
                  return <button className="cv-item is-gen-box" key={material.id} type="button" disabled={Boolean(blocked)} title={blocked || (onCanvas ? '已在画布上：点击定位到这个框体' : undefined)} onClick={() => addBoxToCanvas(box)}>
                    <span className={`cv-item__icon is-${visual.tone}`}><Icon name={visual.icon} size={15} /></span>
                    <span className="cv-item__text"><strong>{material.title}</strong><small>{visual.label} · {boxParamsLabel(box)} · {state}{blocked ? ' · ' + blocked : ''}</small></span>
                    <b className="cv-item__plus">{onCanvas ? '◎' : '＋'}</b>
                  </button>;
                }
                // 提示词素材：全是「素材1 / 素材2」时分不清哪条是哪条（用户 2026-09-17 报的第 3 条），
                // 所以把内容摘要放在副标题上，鼠标悬停看全文。
                const promptText = String(material.snapshot?.content || material.description || '').replace(/\s+/g, ' ').trim();
                const subtitle = material.materialType === 'PROMPT'
                  ? (promptText ? (promptText.length > 18 ? `${promptText.slice(0, 18)}…` : promptText) : '点击后选择插入到哪个框体')
                  : (material.description || '点击后加入画布');
                const hover = material.materialType === 'PROMPT' && promptText
                  ? `${material.title || '提示词'}｜${promptText.length > 300 ? `${promptText.slice(0, 300)}…` : promptText}`
                  : (editable ? undefined : '课堂已结束，不能再修改画布');
                return <button className="cv-item" key={material.id || material.title} type="button" disabled={!editable} title={hover} onClick={() => material.materialType === 'PROMPT' ? openPromptInsert(material) : addLessonMaterialToCanvas(material)}>
                  <span className={`cv-item__icon is-${visual.tone}`}><Icon name={visual.icon} size={15} /></span>
                  <span className="cv-item__text"><strong>{material.title}</strong><small>{editable ? subtitle : '课堂已结束，不能再修改画布'}</small></span>
                  <b className="cv-item__plus">＋</b>
                </button>;
              })}
              {(activeGroup.materials || []).length ? null : <p className="cv-empty">这一组还没有素材。</p>}
            </div>
          </> : null}
          {toolPanel === 'local' ? <>
            <div className="cv-panel__head"><div><strong>本地素材</strong><small>你从电脑拖进画布的图片 / 视频 / 音频</small></div><button type="button" className="cv-sidebar__close" onClick={() => setToolPanel(null)}><Icon name="close" size={14} /></button></div>
            <div className="cv-group">{localMaterials.map((item) => <button className="cv-item" key={item.id} type="button" disabled={!editable} title={editable ? '定位到画布上的这个框体' : '课堂已结束，不能再修改画布'} onClick={() => setFocusRequest({ id: item.id, token: Date.now() })}>
              <span className={`cv-item__icon is-${item.kind === '视频' ? 'video' : item.kind === '音频' ? 'audio' : 'image'}`}><Icon name={item.kind === '视频' ? 'video' : item.kind === '音频' ? 'music' : 'image'} size={15} /></span>
              <span className="cv-item__text"><strong>{item.title}</strong><small>{item.kind} · {item.uploading ? '上传中…' : '本地素材 · 已在画布上'}</small></span>
              <b className="cv-item__plus">◎</b>
            </button>)}</div>
          </> : null}
          {toolPanel === 'materials' ? <>
            <div className="cv-panel__head"><div><strong>课堂素材</strong><small>{editable ? '点框体或素材加入画布' : '课堂已结束，不能再修改画布'}</small></div><button type="button" className="cv-sidebar__close" onClick={() => setToolPanel(null)}><Icon name="close" size={14} /></button></div>
            <p className="cv-empty">老师还没有为本节课配置素材；把电脑里的图片/视频/音频直接拖进画布，也会出现在这里。</p>
          </> : null}
          {toolPanel === 'capabilities' ? <>
            <div className="cv-panel__head"><div><strong>本课开放能力</strong><small>未勾选的 AI 能力不会出现在画布中</small></div><button type="button" className="cv-sidebar__close" onClick={() => setToolPanel(null)}><Icon name="close" size={14} /></button></div>
            <div className="cv-chips">{[['text', 'AI 文字'], ['image', 'AI 生图'], ['video', 'AI 生视频'], ['music', 'AI 音乐']].map(([key, label]) => <span className={`cv-chip ${capabilities.includes(key) ? 'is-on' : ''}`} key={key}>{capabilities.includes(key) ? '✓' : '—'} {label}</span>)}</div>
          </> : null}
          
        </div> : null}
      </aside>
      <div className="cv-main">
        {/* 原来这里有一条「我的课堂画布 + 作品名 + 已保存」的横条，占掉一行的画布高度；
            用户 2026-09-17 口径：那两处文案删掉、「已保存」挪到顶部即可，给画布留更多空间。
            所以这条横条整条没了 —— 保存状态在上面的顶栏里（顶栏中间本来就有课时名，
            作品名也随这条横条一起去掉，需要的话说一声再加回来）。 */}
        <div className="cv-viewport"><CanvasEditor key={`${project.data.id}-${canvasVersion}-${canvasRevision}`} initialSnapshot={canvasSnapshot || project.data.canvasSnapshot} capabilities={capabilities} readOnly={!editable} allowNodeCreation={false} boxModalities={boxModalities} showStarter={false} onGenerateNode={prepMode ? undefined : generateCanvasNode} onUploadFiles={prepMode ? undefined : uploadFiles} resolveAssetUrl={resolveAssetUrl} onRequestMaterials={openMaterialsPanel} onChange={setDraft} focusRequest={focusRequest} entranceRequest={entranceRequest} placementRef={placementRef} /></div>
      </div>
    </section>
    {message && <div className={`cv-toast ${isErrorText(message) ? 'is-error' : ''}`}>{stripNoticeMark(message)}</div>}
    {promptTarget && <div className="cv-dialog" role="dialog" aria-modal="true"><div className="cv-dialog__panel"><strong>把「{promptTarget.material.title}」插入到哪个框体？</strong><div className="cv-dialog__list">{promptTarget.targets.map((node) => <button key={node.id} type="button" onClick={() => insertPromptToSlot(node.id)}>{node.data?.title || node.type}<small>{PROMPT_SLOT_ACTION[String(node.data?.slotType || '')] || ''}{node.data?.aspectRatio ? ' · ' + node.data.aspectRatio : ''}</small></button>)}</div><button type="button" className="cv-text-btn" onClick={() => setPromptTarget(null)}>取消</button></div></div>}
  </main>;

}

