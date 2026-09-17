// VibeCoding 课堂：课程入口 + 对话式创作工作区。
//
// 工作区按 OpenSquilla 的控制台设计重建（见 console/ 目录与仓库根 THIRD-PARTY-NOTICES.md）：
// 左侧会话栏 / 中间对话流 / 右侧工作台（预览·源码·控制台）。学生不手写代码，
// 代码只有一个来源——AI 回复里带文件名的围栏，落到「产物」，在工作台里预览与查看。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button, ConfirmDialog, ConsoleIcon, ConsoleEmpty, Pill, PopoverMenu, Spinner,
  ConsoleShell, ChatThread, Composer, Workbench, ToastProvider,
  useFollowScroll, useDockHeight, useWorkbenchWidth, useToast,
} from './console/index.js';
import { useData } from './classroom.jsx';
import { buildPreviewDocument, downloadTextFile, isSubmittableArtifact } from './vibecodingProject.js';
import { consumeVibeCodingStream } from './vibecodingStream.js';
import { relativeTime } from './console/format.js';
import { useRuntimeStatus, useRuntimeLaunch } from './runtimeWorkspace.jsx';
import {
  ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, MAX_INLINE_BYTES, isDocumentArtifact,
  attachmentSizeLimit, attachmentSizeMessage,
} from './console/attachments.js';

const DEFAULT_TITLE = '新的创作对话';

/**
 * 学生进课堂时选的「做什么」（2026-09-17）。三张卡片只在**还没聊过**的时候出现；
 * 选中之后它会随会话存下来，服务端据此拼系统提示词（见 vibecoding.js 的 lessonSystemMessage）。
 *
 * ⚠️ 这里只决定「AI 干什么、默认产出什么」，**不决定能力边界** —— 三个选项都能写网页、做文档，
 * 所以别在文案里承诺「对话就不能做网页」，那是错的。
 */
const MODE_CARDS = [
  {
    id: 'CHAT', icon: 'messageSquare', title: '对话',
    desc: '不懂就问：讲解、答疑、帮你想思路',
    prompts: ['帮我讲讲什么是循环', '这个游戏的猫怎么才能追得更智能？', '我这关太难了，怎么改简单一点'],
  },
  {
    id: 'CODE', icon: 'code', title: '写代码',
    desc: '一起写代码，每段都讲清楚在干什么',
    prompts: ['写一个猜数字的小游戏', '教我用键盘控制角色移动', '帮我看看这段代码为什么不动'],
  },
  {
    id: 'WEB', icon: 'globe', title: '做网页',
    desc: '做一个能在右边直接看到的网页',
    prompts: ['做一个点击按钮会变色的网页', '做一个我自己的名片网页', '做一个记录心情的页面'],
  },
];
const MODE_TITLE = Object.fromEntries(MODE_CARDS.map((card) => [card.id, card.title]));
// 思考过程在界面上最多展示这么多字符（只保留尾部）——长推理没必要全塞进 DOM
const REASONING_TAIL_CHARS = 4000;
// 附件的类型 / 张数 / 大小上限都在 console/attachments.js（与服务端白名单对齐，有 p44 盯着）

function filesFromArtifacts(artifacts) {
  return Object.fromEntries((artifacts || []).map((item) => [item.name, String(item.content ?? '')]));
}

function entryOf(artifacts, preferred) {
  const list = artifacts || [];
  if (preferred && list.some((item) => item.name === preferred)) return preferred;
  return list.find((item) => item.name === 'index.html')?.name
    || list.find((item) => item.kind === 'html')?.name
    || list[0]?.name
    || 'index.html';
}

/** 触发一次「保存到本地」；文档产物走服务端渲染接口，其余仍在前端直接落盘 */
async function saveArtifact({ api, conversationId, artifact }) {
  if (isDocumentArtifact(artifact.kind)) {
    // 走 fetchBlobUrl 是为了带上 Authorization（<a href> 带不了），拿到 blob: 再触发下载
    const url = await api.fetchBlobUrl(`student/vibecoding/conversations/${conversationId}/artifacts/${artifact.id}/download`);
    const link = document.createElement('a');
    link.href = url;
    link.download = artifact.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  downloadTextFile(
    artifact.name,
    String(artifact.content ?? ''),
    artifact.kind === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8',
  );
}

// ── 课程入口 ────────────────────────────────────────────────────────────────
function ClassroomView({ api, onEnterConversation }) {
  const navigate = useNavigate();
  const toast = useToast();
  const dashboard = useData(() => api.get('student/dashboard'), [api]);
  const conversations = useData(() => api.get('student/vibecoding/conversations?limit=50'), [api]);
  const [busy, setBusy] = useState(null);

  if (dashboard.loading) return <div className="c-page" data-console="vibecoding"><div className="c-page__center"><Spinner /> 正在读取 VibeCoding 课程…</div></div>;
  if (dashboard.error) return <div className="c-page" data-console="vibecoding"><div className="c-page__center"><ConsoleEmpty icon="alert" title="课程读取失败" body={dashboard.error.message} /></div></div>;

  const courses = (dashboard.data?.classroomCourses || [])
    .map((course) => ({ ...course, lessons: (course.lessons || []).filter((lesson) => lesson.deliveryMode === 'VIBECODING') }))
    .filter((course) => course.lessons.length);
  const byLesson = new Map((conversations.data?.items || []).filter((item) => item.lessonId).map((item) => [item.lessonId, item]));

  async function enter(lesson) {
    if (!lesson.canStartVibeCoding) return;
    setBusy(lesson.id);
    try {
      const target = onEnterConversation || ((id) => navigate(`/learn/vibecoding/${id}`));
      const created = await api.post('student/vibecoding/conversations', {
        sessionId: lesson.session?.id,
        lessonId: lesson.id, title: `${lesson.title || '今日课堂'} · 创作对话`,
      });
      target(created.id);
    } catch (error) {
      toast.error(error.message || '进入课堂失败');
    } finally { setBusy(null); }
  }

  return (
    <div className="c-page" data-console="vibecoding">
      <header className="c-page__head">
        <div>
          <p className="c-eyebrow">VibeCoding 上课</p>
          <h1>选一节课，和 AI 一起做东西</h1>
          <p className="c-page__sub">用一句话说清你要什么，AI 边想边做；它做出来的文件会放到右边，能预览的直接就能玩。</p>
        </div>
        <div className="c-page__actions">
          <Button variant="ghost" icon="refresh" onClick={() => { dashboard.refresh(); conversations.refresh(); }}>刷新</Button>
          <Button variant="ghost" icon="home" onClick={() => navigate('/learn')}>学习中心</Button>
        </div>
      </header>

      {courses.length ? courses.map((course) => (
        <section className="c-page__section" key={course.id}>
          <div className="c-page__section-head">
            <span className="c-eyebrow">{course.title}</span>
            <span className="c-dim">共 {course.lessons.length} 节</span>
          </div>
          <div className="c-lesson-grid">
            {course.lessons.map((lesson, index) => {
              const candidate = byLesson.get(lesson.id);
              const existing = candidate?.classSessionId === lesson.session?.id ? candidate : null;
              const startable = Boolean(lesson.canStartVibeCoding);
              return (
                <article
                  className={`c-card c-fade-item c-lesson${startable ? '' : ' is-locked'}`}
                  key={lesson.id}
                  style={{ '--i': index }}
                >
                  <div className="c-lesson__top">
                    <span className="c-lesson__no">{String(lesson.sort).padStart(2, '0')}</span>
                    {lesson.hasGrant === false
                      ? <Pill tone="warn">未授权</Pill>
                      : startable
                        ? <Pill tone="ok">上课中</Pill>
                        : lesson.participationStatus === 'COMPLETED'
                          ? <Pill tone="ok">已完课</Pill>
                          : lesson.participationStatus === 'PENDING'
                            ? <Pill tone="warn">待上课</Pill>
                            : lesson.participationStatus === 'INCOMPLETE'
                              ? <Pill tone="warn">未完课</Pill>
                              : lesson.participationStatus === 'REMOVED'
                                ? <Pill tone="warn">已被移出课堂</Pill>
                                : <Pill tone="warn">未加入课堂</Pill>}
                  </div>
                  <h3 className="c-lesson__title">{lesson.title}</h3>
                  <p className="c-lesson__summary">{lesson.summary || '本节课的创作任务会显示在这里。'}</p>
                  <div className="c-lesson__meta">
                    {lesson.teacherName ? `授课老师：${lesson.teacherName}` : '授课老师：待分配'}
                    {lesson.sessionTitle ? ` · 课堂：${lesson.sessionTitle}` : ''}
                    {existing ? ` · 已有 ${existing.artifactCount || 0} 个文件` : ''}
                  </div>
                  <div className="c-lesson__foot">
                    <span className="c-dim">{lesson.vibeCodingBlockReason || (existing ? '继续上次的创作。' : '开始一节新的创作。')}</span>
                    <Button
                      variant={startable ? 'primary' : 'default'}
                      disabled={!startable || busy === lesson.id}
                      icon={existing ? 'messageSquare' : 'wand'}
                      onClick={() => enter(lesson)}
                    >
                      {busy === lesson.id ? '进入中…' : existing ? '继续创作' : '进入创作'}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )) : (
        <ConsoleEmpty icon="wand" title="暂无 VibeCoding 课时" body="老师在课程包里把课时设为 VibeCoding 课堂后，这里会显示。" />
      )}
    </div>
  );
}

// ── 创作工作区 ──────────────────────────────────────────────────────────────
function WorkspaceView({ api }) {
  const navigate = useNavigate();
  const params = useParams();
  const conversationId = params?.conversationId;
  const activeConversationIdRef = useRef(conversationId);
  activeConversationIdRef.current = conversationId;
  const toast = useToast();
  const apiRef = useRef(api);
  apiRef.current = api;

  const [search, setSearch] = useState('');
  const conversation = useData(() => api.get(`student/vibecoding/conversations/${conversationId}`), [api, conversationId]);
  const list = useData(() => api.get(`student/vibecoding/conversations?limit=50${search ? `&search=${encodeURIComponent(search)}` : ''}`), [api, conversationId, search]);
  // 创作环境（沙箱）与「让 AI 真的做出来」：这是**升级点**，不是入口。
  // ⚠️ 这两个 hook 必须在下面那些提前 return **之前**调用（本文件 297 行附近有 return），
  //    否则会「少一个 hook」直接崩 —— 这个坑在 classroom.jsx 里已经踩过一次并留了注释。
  const runtime = useRuntimeStatus(api);
  const launch = useRuntimeLaunch(api, { enabled: runtime.ready });
  // 「让 AI 真的做出来」失败/退出的原因必须**说出来**（这台机器没配好、脚本失败、没有进行中的课堂…）。
  // ⚠️ 必须放在下面那些提前 return **之前**：hook 顺序不能变。
  // ⚠️ 更重要的原因：不显示的话，「点了没反应」就成了这个项目最怕的那种
  //    「不报错、只表现为卡住」—— 我第一版正是漏了这一段，浏览器实检时当场抓到。
  useEffect(() => {
    if (!launch.message) return;
    toast.error(launch.message);
    launch.clearMessage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launch.message]);
  // 学生刚点的选项（还没落库前先本地生效，免得等一个回包才变色）
  const [pickedMode, setPickedMode] = useState(null);

  const [messages, setMessages] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [draft, setDraft] = useState('');
  // 待发送的附件：上传后保持私有；图片通过 inline 给模型看，页面预览按登录态转成 blob URL。
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const attachInputRef = useRef(null);
  const [streaming, setStreaming] = useState(false);
  const [tab, setTab] = useState('preview');
  const [consoleLines, setConsoleLines] = useState([]);
  const [previewAssetMap, setPreviewAssetMap] = useState({});
  // 工作台**默认收起**：学生上课时对话是主角，右边一直杵着一块预览区很干扰。
  // 任务真的产出了东西时会自动弹出来（见 streamReply 里的 onArtifact），学生也可以随时手动开。
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  // 预览区当前看的是哪个产物（点产物卡片 / 点文件页签会切）；为空时由 Workbench 自行决定看最新的
  const [selectedArtifactName, setSelectedArtifactName] = useState(null);
  const [editing, setEditing] = useState(null);
  const [menu, setMenu] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const abortRef = useRef(null);
  // 每一轮只自动弹一次工作台：学生自己关掉之后，别再被同一轮里的后续产物顶开
  const autoOpenedRef = useRef(false);
  // 模型推理是流式推下来的增量，这里累积成可展示的文本；只留尾部，避免长推理把内存和界面撑爆
  const reasoningRef = useRef('');

  const workbench = useWorkbenchWidth();
  const dock = useDockHeight();
  const follow = useFollowScroll([
    messages.length,
    streaming,
    messages[messages.length - 1]?.content?.length || 0,
    messages[messages.length - 1]?.artifacts?.length || 0,
  ]);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setArtifacts([]);
    setDraft('');
    setAttachments([]);
    setConsoleLines([]);
    setSelectedArtifactName(null);
    setWorkbenchOpen(false);
    setStreaming(false);
    reasoningRef.current = '';
    autoOpenedRef.current = false;
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [conversationId]);

  // 加载会话：把产物按 messageId 挂回对应消息，聊天里才能显示「这一轮写了哪些文件」
  useEffect(() => {
    const data = conversation.data;
    if (!data) return;
    const loaded = data.artifacts || [];
    setArtifacts(loaded);
    setMessages((data.messages || []).map((message) => ({
      ...message,
      artifacts: message.role === 'assistant' ? loaded.filter((item) => item.messageId === message.id) : [],
      activity: [],
    })));
  }, [conversation.data?.id, conversation.data?.updatedAt]);

  const previewAssetSourceKey = useMemo(() => JSON.stringify(
    [...new Set([
      ...messages.flatMap((message) => (message.attachments || []).map((item) => item.url)),
      ...artifacts.flatMap((artifact) => [
        ...(artifact.generatedImages || []).map((item) => item.url),
        ...(artifact.attachmentImages || []).map((item) => item.fileId ? `/api/student/file-assets/${item.fileId}/download` : ''),
      ]),
    ].filter((url) => String(url).startsWith('/api/student/file-assets/'))) ],
  ), [messages, artifacts]);
  useEffect(() => {
    const urls = JSON.parse(previewAssetSourceKey);
    let live = true;
    const created = [];
    Promise.all(urls.map(async (url) => {
      try {
        const blobUrl = await apiRef.current.fetchBlobUrl(url);
        created.push(blobUrl);
        return [url, blobUrl];
      } catch { return [url, '']; }
    })).then((entries) => {
      if (live) setPreviewAssetMap(Object.fromEntries(entries.filter(([, value]) => value)));
      else created.forEach((url) => URL.revokeObjectURL(url));
    });
    return () => {
      live = false;
      created.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [conversationId, previewAssetSourceKey]);

  // 没有「老师点评」这一环了，所以**提交之后也能继续改**（学生想接着优化是常态）。
  // 只有归档会话才是只读；提交本身不再锁创作。
  const editable = conversation.data?.status !== 'ARCHIVED';
  const defaultEntryFile = useMemo(() => entryOf(artifacts, conversation.data?.entryFile), [artifacts, conversation.data?.entryFile]);
  const selectedArtifact = useMemo(
    () => artifacts.find((item) => item.name === selectedArtifactName) || null,
    [artifacts, selectedArtifactName],
  );
  const previewEntryFile = selectedArtifact && (selectedArtifact.kind === 'html' || /\.html?$/i.test(selectedArtifact.name))
    ? selectedArtifact.name
    : defaultEntryFile;
  const previewHtml = useMemo(() => {
    let document = buildPreviewDocument(filesFromArtifacts(artifacts), previewEntryFile);
    for (const [source, resolved] of Object.entries(previewAssetMap)) document = document.split(source).join(resolved);
    return document;
  }, [artifacts, previewEntryFile, previewAssetMap]);

  if (conversation.loading) return <div className="c-page" data-console="vibecoding"><div className="c-page__center"><Spinner /> 正在打开创作工作区…</div></div>;
  if (conversation.error) return <div className="c-page" data-console="vibecoding"><div className="c-page__center"><ConsoleEmpty icon="alert" title="打开失败" body={conversation.error.message} /></div></div>;

  const data = conversation.data;
  // 这一节选的「做什么」。学生刚点的本地先生效；老会话没有 mode → null（界面按老行为走）。
  const effectiveMode = pickedMode ?? data.mode ?? null;
  // 卡片只在**还没聊过**时出现：聊起来之后换选项会让前后两套角色说明打架（服务端也会 409）。
  const canPickMode = !messages.length && !streaming;

  /** 更新某条消息上的活动步骤（同 id 覆盖，避免流式期间堆出几十条） */
  function pushActivity(messageId, step) {
    setMessages((current) => current.map((item) => {
      if (item.id !== messageId) return item;
      const steps = item.activity || [];
      const index = steps.findIndex((existing) => existing.id === step.id);
      return { ...item, activity: index < 0 ? [...steps, step] : steps.map((existing, i) => (i === index ? { ...existing, ...step } : existing)) };
    }));
  }

  /**
   * 统一的流式回复：发送 / 重新生成 / 编辑重发共用。
   * 产物在流式期间就到（artifact 事件），所以卡片是一个个出现的。
   */
  async function streamReply(route, body, { optimistic = [] } = {}) {
    const requestConversationId = conversationId;
    const isCurrentConversation = () => activeConversationIdRef.current === requestConversationId;
    setStreaming(true);
    reasoningRef.current = '';
    autoOpenedRef.current = false;
    const localId = `local-assistant-${Date.now()}`;
    const startedAt = new Date().toISOString();
    setMessages((current) => [...current, ...optimistic,
      { id: localId, role: 'assistant', content: '', status: 'STREAMING', createdAt: startedAt, startedAt, activity: [], artifacts: [] },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    let answered = false;

    try {
      const response = await api.stream(`student/vibecoding/conversations/${conversationId}/${route}`, { body, signal: controller.signal });
      await consumeVibeCodingStream(response, {
        onStatus: (payload) => {
          if (!isCurrentConversation()) return;
          // 插画生成走同一条 status 通道，但用 phase 区分开：
          // 它不是「模型在思考」，而是「平台在收集素材」，学生看到的应当是后者。
          if (payload?.phase === 'image') {
            const { done = 0, total = 0, error } = payload;
            pushActivity(localId, {
              id: 'illustration',
              label: error ? '插画没做成' : '正在配图',
              detail: error ? String(error) : (total ? `第 ${Math.min(done + 1, total)} / ${total} 张` : '准备中'),
            });
            return;
          }
          const { chars, delta } = payload || {};
          if (delta) reasoningRef.current = (reasoningRef.current + delta).slice(-REASONING_TAIL_CHARS);
          const text = reasoningRef.current;
          pushActivity(localId, { id: 'think', label: text ? '思考过程' : '推理中', detail: text || `已推理 ${chars} 字`, reasoning: true });
        },
        onDelta: (_payload, full) => {
          if (!isCurrentConversation()) return;
          answered = true;
          setMessages((current) => current.map((item) => (item.id === localId ? { ...item, content: full } : item)));
        },
        onArtifact: ({ artifact, created }) => {
          if (!isCurrentConversation()) return;
          setArtifacts((current) => {
            const next = current.filter((item) => item.id !== artifact.id);
            return [...next, artifact];
          });
          setMessages((current) => current.map((item) => (item.id === localId
            ? { ...item, artifacts: [...(item.artifacts || []).filter((a) => a.id !== artifact.id), artifact] }
            : item)));
          pushActivity(localId, { id: `write-${artifact.name}`, label: created ? '新建文件' : '更新文件', detail: artifact.name });
          if (created) toast.ok(`写好了 ${artifact.name}`);
          // 「跑任务用到工作台」——这一轮第一次产出东西时把它弹出来，并直接看向这个产物。
          // 只在宽屏这么做：窄屏下工作台会盖住对话，流式过程中把对话挡掉更糟。
          if (!autoOpenedRef.current) {
            autoOpenedRef.current = true;
            setSelectedArtifactName(artifact.name);
            if (typeof window !== 'undefined' && window.innerWidth > 720) setWorkbenchOpen(true);
          }
        },
        onDone: ({ message, artifacts: authoritative, elapsedMs }) => {
          if (!isCurrentConversation()) return;
          setArtifacts(authoritative || []);
          setMessages((current) => current.map((item) => (item.id === localId
            ? { ...message, startedAt, elapsedMs, activity: item.activity, artifacts: (authoritative || []).filter((a) => a.messageId === message.id) }
            : item)));
        },
        onAborted: (_payload, full) => {
          if (!isCurrentConversation()) return;
          setMessages((current) => current.map((item) => (item.id === localId ? { ...item, status: 'ABORTED', content: full } : item)));
        },
        onError: ({ message }) => {
          if (!isCurrentConversation()) return;
          setMessages((current) => current.map((item) => (item.id === localId ? { ...item, status: 'FAILED', errorMessage: message } : item)));
        },
      });
      // 兜底：整轮没有 delta 也没有 error 时，别让消息永远停在「生成中」
      if (isCurrentConversation()) setMessages((current) => current.map((item) => (item.id === localId && item.status === 'STREAMING'
        ? { ...item, status: answered ? 'SUCCEEDED' : 'FAILED', errorMessage: answered ? undefined : 'AI 没有返回内容' }
        : item)));
      list.refresh();
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      if (isCurrentConversation()) setMessages((current) => current.map((item) => (item.id === localId
        ? { ...item, status: aborted ? 'ABORTED' : 'FAILED', errorMessage: aborted ? undefined : error.message }
        : item)));
      if (!aborted && isCurrentConversation()) toast.error(error.message || 'AI 回复失败');
    } finally {
      if (isCurrentConversation()) {
        abortRef.current = null;
        setStreaming(false);
      }
    }
  }

  /**
   * 上传附件：存成本人私有素材；图片用内联 data URL 给模型看，页面预览走临时 blob URL。
   *
   * 什么都能传（图片/音视频/文档，以服务端的白名单为准），但**只有图片能被模型看见** ——
   * 上游只认 image_url，PDF/视频没有内联这条路，服务端会如实告诉模型「这些文件你看不到」。
   */
  async function uploadFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files) {
        if (attachments.length >= MAX_ATTACHMENTS) { toast.error(`一次最多传 ${MAX_ATTACHMENTS} 个附件`); break; }
        const isImage = String(file.type || '').startsWith('image/');
        const probe = { name: file.name, mime: file.type, inline: isImage ? 'data:image/' : '' };
        const limit = attachmentSizeLimit(probe);
        if (file.size > limit) { toast.error(attachmentSizeMessage(file.name, limit)); continue; }
        const asset = await api.upload('student/file-assets/upload', file, { category: 'MEDIA_ASSET', visibility: 'PRIVATE' });
        // 上游不抓公网地址，模型要「看见」图只能内联；超限就不带 inline（并如实告诉学生）
        let inline = '';
        if (isImage) {
          if (file.size <= MAX_INLINE_BYTES) {
            inline = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = () => resolve('');
              reader.readAsDataURL(file);
            });
          } else {
            toast.toast(`${file.name} 超过 ${Math.round(MAX_INLINE_BYTES / 1024 / 1024)}MB，AI 看不到它，但页面里可以用`);
          }
        } else {
          toast.toast(`${file.name} 已附上；AI 看不到它的内容，页面里可以下载`);
        }
        setAttachments((current) => (current.length >= MAX_ATTACHMENTS
          ? current
          : [...current, {
            id: asset.id, name: asset.fileName || file.name,
            url: `/api/student/file-assets/${asset.id}/download`,
            mime: asset.mimeType || file.type || '', inline,
          }]));
      }
    } catch (error) {
      toast.error(error.message || '附件上传失败');
    } finally {
      setUploading(false);
    }
  }

  /**
   * 预览用：把文档规格里的配图翻成图片地址。
   *
   * 两种来源，与服务端（routes/vibecoding.js 的 attachmentImageMap / generatedImageMap）同一口径：
   *   · 平台生成的插画 → 产物自带 generatedImages（按幻灯片下标）；
   *   · {"attachment": N} → **产出那一轮**里学生传的第 N 张图（按顺序编号、非图片附件不占号）。
   * 服务端才是权威（下载出来的文件以它为准），这里只是让预览里也能看见图。
   */
  function resolveAttachmentImage(artifact, { slide, slideIndex }) {
    const generated = (artifact?.generatedImages || []).find((item) => Number(item.slideIndex) === slideIndex && item.url && !item.error);
    if (generated) return previewAssetMap[generated.url] || generated.url;
    const ordinal = Number(slide?.image?.attachment ?? slide?.imageAttachment);
    if (!ordinal) return null;
    const persisted = (artifact?.attachmentImages || []).find((item) => Number(item.index) === ordinal && item.fileId);
    if (persisted) {
      const source = `/api/student/file-assets/${persisted.fileId}/download`;
      return previewAssetMap[source] || source;
    }
    const index = messages.findIndex((item) => item.id === artifact?.messageId);
    const before = index >= 0 ? messages.slice(0, index) : messages;
    for (let cursor = before.length - 1; cursor >= 0; cursor -= 1) {
      const message = before[cursor];
      if (message.role !== 'user' || !message.attachments?.length) continue;
      const images = message.attachments.filter((item) => String(item.mime || '').startsWith('image/'));
      const source = images[ordinal - 1]?.url || '';
      return previewAssetMap[source] || source || null;
    }
    return null;
  }

  function recordConsoleLine(line) {
    const normalized = {
      level: String(line?.level || 'log'),
      text: String(line?.text || '').slice(0, 1200),
      source: String(line?.source || '浏览器'),
    };
    setConsoleLines((current) => {
      const last = current[current.length - 1];
      if (last && last.level === normalized.level && last.text === normalized.text) return current;
      return [...current.slice(-99), normalized];
    });
    if (['error', 'err'].includes(normalized.level.toLowerCase())) setTab('console');
  }

  function fixConsoleErrors() {
    const errors = consoleLines.filter((line) => ['error', 'err'].includes(String(line.level).toLowerCase()));
    if (!errors.length || streaming || !editable) return;
    const target = isSubmittableArtifact(selectedArtifact) ? selectedArtifact.name : previewEntryFile;
    if (!target) return;
    const details = errors.slice(-5).map((line) => `- ${line.text}`).join('\n');
    streamReply('messages', {
      content: `请修复当前作品 ${target} 的浏览器运行错误。保持现有设计和功能，不要只解释，要直接输出修复后的完整文件。\n\n浏览器错误：\n${details}`,
      attachments: [],
    }, {
      optimistic: [{
        id: `local-user-${Date.now()}`, role: 'user', content: `请修复 ${target} 的运行错误`, status: 'SUCCEEDED',
        createdAt: new Date().toISOString(), attachments: [],
      }],
    });
  }

  function send(text) {
    const content = String(text ?? draft).trim();
    if (streaming || !editable) return;
    // 只发图不打字是允许的（服务端也这么认）
    if (!content && !attachments.length) return;
    const pending = attachments;
    setDraft('');
    setAttachments([]);
    streamReply('messages', { content, attachments: pending.map((item) => ({ id: item.id, inline: item.inline || '' })) }, {
      optimistic: [{
        id: `local-user-${Date.now()}`, role: 'user', content: content || '（附件）', status: 'SUCCEEDED',
        createdAt: new Date().toISOString(), attachments: pending,
      }],
    });
  }

  function regenerate() {
    if (streaming || !editable) return;
    setMessages((current) => { const next = [...current]; while (next.length && next[next.length - 1].role === 'assistant') next.pop(); return next; });
    streamReply('messages/regenerate', {});
  }

  function submitEdit() {
    const content = String(editing?.content || '').trim();
    if (!content || streaming) return;
    const messageId = editing.id;
    setEditing(null);
    setMessages((current) => {
      const next = [...current];
      const index = next.findIndex((item) => item.id === messageId);
      if (index >= 0) { next[index] = { ...next[index], content }; next.length = index + 1; }
      return next;
    });
    streamReply(`messages/${messageId}/edit`, { content });
  }

  async function deleteMessage(message) {
    if (streaming || !editable) return;
    setConfirm({
      title: '删除这条消息？',
      body: '它之后的回答会一起删掉。',
      tone: 'danger',
      confirmLabel: '删除',
      onConfirm: async () => {
        setConfirm(null);
        try {
          await api.delete(`student/vibecoding/conversations/${conversationId}/messages/${message.id}`);
          setMessages((current) => {
            const index = current.findIndex((item) => item.id === message.id);
            return index < 0 ? current : current.slice(0, index);
          });
        } catch (error) { toast.error(error.message || '删除失败'); }
      },
    });
  }

  async function clearMessages() {
    if (streaming || !editable || !messages.length) return;
    setConfirm({
      title: '清空聊天记录？',
      body: '会话和已产出的文件会保留。',
      tone: 'danger',
      confirmLabel: '清空',
      onConfirm: async () => {
        setConfirm(null);
        try {
          const result = await api.delete(`student/vibecoding/conversations/${conversationId}/messages`);
          setMessages([]);
          if (Array.isArray(result?.artifacts)) setArtifacts(result.artifacts);
          toast.ok('聊天记录已清空');
        } catch (error) { toast.error(error.message || '清空失败'); }
      },
    });
  }

  async function createConversation() {
    try {
      const created = await api.post('student/vibecoding/conversations', { lessonId: data.lessonId, classId: data.classId, title: DEFAULT_TITLE });
      navigate(`/learn/vibecoding/${created.id}`);
    } catch (error) { toast.error(error.message || '新建失败'); }
  }

  async function togglePin(session) {
    try {
      await api.put(`student/vibecoding/conversations/${session.id}/pin`, { pinned: !session.pinnedAt });
      list.refresh();
    } catch (error) { toast.error(error.message || '置顶失败'); }
  }

  async function renameConversation(session) {
    setConfirm({
      title: '重命名对话',
      input: { label: '对话名称', initial: session.title, placeholder: '给这次创作起个名字' },
      confirmLabel: '保存',
      onConfirm: async (value) => {
        setConfirm(null);
        const title = String(value || '').trim();
        if (!title) return;
        try {
          await api.put(`student/vibecoding/conversations/${session.id}`, { title });
          if (session.id === conversationId) conversation.refresh();
          list.refresh();
        } catch (error) { toast.error(error.message || '重命名失败'); }
      },
    });
  }

  async function removeConversation(session) {
    setConfirm({
      title: '删除这个创作对话？',
      body: '聊天记录和产出的文件都会一起删除，不能恢复。',
      tone: 'danger',
      confirmLabel: '删除',
      onConfirm: async () => {
        setConfirm(null);
        try {
          await api.delete(`student/vibecoding/conversations/${session.id}`);
          if (session.id === conversationId) navigate('/learn/vibecoding');
          else list.refresh();
        } catch (error) { toast.error(error.message || '删除失败'); }
      },
    });
  }

  async function changeModel(nextModel) {
    try {
      await api.put(`student/vibecoding/conversations/${conversationId}`, { model: nextModel });
      conversation.refresh();
      list.refresh();
    } catch (error) { toast.error(error.message || '切换模型失败'); }
  }

  /** 选「做什么」（对话 / 写代码 / 做网页）：只在还没聊过时可选，服务端也这么判（聊过会 409）。 */
  async function chooseMode(mode) {
    const previous = pickedMode;
    setPickedMode(mode);
    try {
      await api.put(`student/vibecoding/conversations/${conversationId}`, { mode });
      conversation.refresh();
    } catch (error) {
      setPickedMode(previous);
      toast.error(error.message || '选择失败，稍后再试');
    }
  }

  /**
   * 「让 AI 真的做出来」：升级到创作环境（沙箱，dsh）。
   * 它和课程中心那个按钮共用同一个 hook —— 忙状态、超时、跨刷新防重复点只有一份实现。
   * 升级前先把「当前要求」整理成可复制的一段话：沙箱里是**另一段对话、另一份工作区**，
   * 不带上要求，学生进去要从头再说一遍。
   */
  function handoffText() {
    const asks = messages.filter((item) => item.role === 'user').slice(-4).map((item) => `- ${String(item.content || '').slice(0, 200)}`);
    const files = artifacts.map((item) => `- ${item.name}`);
    return [
      `这节课我要做的东西（${MODE_TITLE[effectiveMode] || 'VibeCoding'}）：`,
      ...(asks.length ? asks : ['- （还没说具体要求）']),
      ...(files.length ? ['', '已经在平台上产出的文件：', ...files] : []),
    ].join('\n');
  }

  /**
   * 「让 AI 真的做出来」：升级到创作环境（沙箱，dsh）。
   * 与课程中心那个按钮共用 `useRuntimeLaunch` —— 忙状态、超时、跨刷新防重复点只有一份实现。
   *
   * 升级前把「当前要求」复制进剪贴板：沙箱里是**另一段对话、另一份工作区**，
   * 不带上要求，学生进去要从头再说一遍（这是这轮明确接受的一个交接代价，见交接文档）。
   */
  async function upgradeToSandbox() {
    let copied = false;
    try { await navigator.clipboard.writeText(handoffText()); copied = true; } catch { copied = false; }
    setConfirm({
      title: '让 AI 真的做出来？',
      body: copied
        ? '会给你开一个创作环境：AI 在那里能真的把代码跑起来、自己看效果、自己改。你刚提的要求已经复制好了，粘到新开的那个页面里就能接着说。'
        : '会给你开一个创作环境：AI 在那里能真的把代码跑起来、自己看效果、自己改。进去之后把要求再说一遍就行。',
      confirmLabel: '打开创作环境',
      onConfirm: () => { setConfirm(null); launch.launch(); },
    });
  }

  // entryFile = 要提交的那份产物（正在预览的那一份）。不传就交给服务端用默认入口。
  function submitWork(entryFile) {
    const requested = artifacts.find((item) => item.name === entryFile);
    const fallback = artifacts.find((item) => item.name === previewEntryFile);
    const target = isSubmittableArtifact(requested) ? requested.name : (isSubmittableArtifact(fallback) ? fallback.name : '');
    if (!artifacts.length || !target) {
      toast.error('请先打开一份网页、PPT、Word 或 Excel 作品');
      return;
    }
    setConfirm({
      title: `提交《${target}》给平台？`,
      body: '请确认这是你自己的作品，并同意平台在作品广场展示。这里提交的是**正在预览的这一份**；同一次创作里的其它产物可以分别提交。提交后不影响你继续修改。',
      confirmLabel: '确认提交',
      onConfirm: async () => {
        setConfirm(null);
        try {
          await api.post(`student/vibecoding/conversations/${conversationId}/submit`, { copyrightConfirmed: true, entryFile: target });
          toast.ok('已交给平台');
          conversation.refresh();
          list.refresh();
        } catch (error) { toast.error(error.message || '提交失败'); }
      },
    });
  }


  const items = list.data?.items || [];
  const pinned = items.filter((item) => item.pinnedAt);
  const recent = items.filter((item) => !item.pinnedAt);
  const modelOptions = data.modelOptions || [];
  const submission = data.submission;
  // 哪些产物已经交给平台（按产物提交，一份作品可以有多次提交）
  const submittedNames = new Set(Array.isArray(data.submittedEntries) ? data.submittedEntries : []);
  const lastUserMessageId = [...messages].reverse().find((item) => item.role === 'user' && !String(item.id).startsWith('local-'))?.id || null;

  const sidebarZones = [
    ...(pinned.length ? [{
      id: 'pinned', label: '置顶', count: pinned.length,
      items: pinned.map(toSessionItem),
    }] : []),
    { id: 'recent', label: pinned.length ? '最近' : '全部对话', count: recent.length, items: recent.map(toSessionItem) },
  ];

  function toSessionItem(session) {
    return {
      id: session.id,
      title: session.title,
      pinned: Boolean(session.pinnedAt),
      timeLabel: relativeTime(session.lastMessageAt || session.createdAt),
      hoverMeta: `${session.artifactCount || 0} 个文件 · ${session.lessonTitle || 'VibeCoding 课堂'} · 创建于 ${relativeTime(session.createdAt)}`,
    };
  }

  return (
    <ConsoleShell
      brand={{ title: 'AI 魔法学院', subtitle: 'VibeCoding 创作课堂' }}
      newLabel="新建对话"
      onNew={createConversation}
      navItems={[
        { id: 'hall', label: '返回课程', icon: 'bookOpen', onClick: () => navigate('/learn/vibecoding') },

      ]}
      zones={sidebarZones}
      activeId={conversationId}
      onSelect={(session) => navigate(`/learn/vibecoding/${session.id}`)}
      onRowMenu={(session, event) => setMenu({ session, anchor: event.currentTarget.getBoundingClientRect() })}
      search={search}
      onSearch={setSearch}
      emptyText={search ? '没有匹配的对话。' : '还没有对话，点「新建对话」开始。'}
      foot={(
        <>
          <span className="c-avatar"><ConsoleIcon name="bookOpen" size={14} /></span>
          <div className="c-sidebar__foot-text">
            <strong>{data.lessonTitle || 'VibeCoding 课堂'}</strong>
            <small>{data.teacherName || '未配置老师'}</small>
          </div>
        </>
      )}
      title={data.title}
      subtitle="正在创作"
      actions={(
        <>

          {submission ? <Pill tone={submission.unpublishReason ? 'warn' : 'ok'} title={submission.unpublishReason || ''}>
            {submission.unpublishReason ? `作品广场已下架：${submission.unpublishReason}` : '已交给平台'}
          </Pill> : null}
          {modelOptions.length ? (
            <select
              className="c-input c-model-select"
              // 会话里没存模型（学生没自己选过）= 跟随渠道默认；这里要**显示成那个默认模型**，
              // 而不是一个空的「渠道默认模型」，否则学生看不出实际在用哪个。
              value={data.model || data.defaultModel || ''}
              disabled={!editable || streaming}
              aria-label="选择模型"
              title={data.model ? '本会话使用的模型' : '本会话跟随渠道默认模型'}
              onChange={(event) => changeModel(event.target.value)}
            >
              {modelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName}{option.id === data.defaultModel ? '（默认）' : ''}
                </option>
              ))}
            </select>
          ) : null}
          <Button size="sm" variant="ghost" icon="refresh" disabled={streaming || !messages.length || !editable} onClick={regenerate}>重新生成</Button>
          {/* 升级点：这台机器配好创作环境（student/runtime/status 说可用）才出现。
              默认不需要它 —— VibeCoding 本来就跑在平台上；学生想要「AI 真的把代码跑起来、
              自己看效果再改」时才点这里。没配好时这块什么也不渲染，入口不会因此变残。 */}
          {runtime.ready ? (
            <Button size="sm" variant="ghost" icon="play" disabled={launch.launching || !editable} onClick={upgradeToSandbox}>
              {launch.launching ? `正在开环境…${launch.elapsed ? ` ${launch.elapsed}s` : ''}` : '让 AI 真的做出来'}
            </Button>
          ) : null}
          {workbenchOpen ? null : (
            <Button size="sm" variant="ghost" icon="eye" onClick={() => setWorkbenchOpen(true)}>预览作品</Button>
          )}
          <Button size="sm" variant="primary" icon="check" disabled={!editable || streaming || !artifacts.some(isSubmittableArtifact)} onClick={() => submitWork(selectedArtifactName)}>
            {submission ? '重新提交' : '提交作品'}
          </Button>
        </>
      )}
    >
      <div
        className="c-content"
        onDragOver={(event) => {
          if (!editable) return;
          event.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!editable) return;
          // 从系统里把文件拖进来就自动上传，不用先点按钮
          uploadFiles(event.dataTransfer?.files);
        }}
      >
        <input
          ref={attachInputRef}
          className="c-file-input"
          type="file"
          accept={ATTACHMENT_ACCEPT}
          multiple
          aria-label="上传附件"
          onChange={(event) => { uploadFiles(event.target.files); event.target.value = ''; }}
        />
        {dragging ? (
          <div className="c-drop-overlay">
            <div className="c-drop-overlay__box">
              <ConsoleIcon name="upload" size={22} />
              松手就上传
            </div>
          </div>
        ) : null}
        <ChatThread
          threadRef={follow.ref}
          messages={messages}
          streaming={streaming}
          dockHeight={dock.height}
          editable={editable}
          lastUserMessageId={lastUserMessageId}
          onRegenerate={regenerate}
          onEditMessage={(message) => setEditing({ id: message.id, content: message.content })}
          onDeleteMessage={deleteMessage}
          onOpenArtifact={(artifact) => {
            setSelectedArtifactName(artifact?.name || null);
            setConsoleLines([]);
            setWorkbenchOpen(true);
            setTab('preview');
            setMenu(null);
          }}
          onDownloadArtifact={(artifact) => {
            saveArtifact({ api, conversationId, artifact })
              .then(() => toast.ok(`已下载 ${artifact.name}`))
              .catch((error) => toast.error(error?.message || '下载失败'));
          }}
          emptyState={(
            <div className="c-landing">
              <span className="c-landing__mark"><ConsoleIcon name="wand" size={24} /></span>
              {canPickMode ? <>
                <h2>今天想做什么？</h2>
                <p>先选一个：选好之后 AI 就按这个角色陪你上课。开始聊之前都能改。</p>
                <div className="c-mode-grid">
                  {MODE_CARDS.map((card) => (
                    <button
                      key={card.id}
                      type="button"
                      className={`c-mode-card${effectiveMode === card.id ? ' is-active' : ''}`}
                      aria-pressed={effectiveMode === card.id}
                      onClick={() => chooseMode(card.id)}
                    >
                      <span className="c-mode-card__icon"><ConsoleIcon name={card.icon} size={18} /></span>
                      <strong>{card.title}</strong>
                      <small>{card.desc}</small>
                    </button>
                  ))}
                </div>
                {effectiveMode ? <div className="c-landing__prompts">
                  {(MODE_CARDS.find((card) => card.id === effectiveMode)?.prompts || []).map((prompt) => (
                    <button key={prompt} type="button" className="c-landing__prompt" onClick={() => { setDraft(prompt); setTimeout(() => send(prompt), 0); }}>
                      {prompt}
                    </button>
                  ))}
                </div> : <p className="c-landing__hint">选好上面一个，这里会给出几个可以照着开的头。</p>}
              </> : <>
                <h2>接着做下去</h2>
                <p>想做什么直接说，AI 会一边想一边做，做出来的东西放在右边随时看。改主意了就接着聊，它会跟着改。</p>
                <div className="c-landing__prompts">
                  {['继续完善这个作品', '帮我加一个新功能', '哪里可以做得更好看一点', '看看有没有哪里会出错'].map((prompt) => (
                    <button key={prompt} type="button" className="c-landing__prompt" onClick={() => { setDraft(prompt); setTimeout(() => send(prompt), 0); }}>
                      {prompt}
                    </button>
                  ))}
                </div>
              </>}
            </div>
          )}
        />

        <div className="c-composer-dock" ref={dock.ref}>
          {!follow.following && messages.length ? (
            <button type="button" className="c-jump-latest" onClick={follow.jumpToLatest} aria-label="跳到最新">
              <ConsoleIcon name="chevronRight" size={15} />
              最新
            </button>
          ) : null}
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={send}
            attachments={attachments}
            uploading={uploading}
            onAttach={() => attachInputRef.current?.click()}
            onPasteFiles={uploadFiles}
            onRemoveAttachment={(item) => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}
            streaming={streaming}
            disabled={!editable}
            blockedReason=""
            placeholder={editable ? '说说你想做什么…' : '已提交，暂时不能再对话'}
            history={messages.filter((item) => item.role === 'user').map((item) => item.content).reverse()}
          />
        </div>
      </div>

      {/* 工作台收起后不渲染：分栏模式下它占的是对话列的空间 */}
      {workbenchOpen ? <Workbench
        mode={workbench.mode}
        width={workbench.width}
        maxWidth={workbench.maxWidth}
        onPreviewWidth={workbench.preview}
        onCommitWidth={workbench.commit}
        tabs={['preview', 'console']}
        artifacts={artifacts}
        previewHtml={previewHtml}
        previewEntryName={previewEntryFile}
        consoleLines={consoleLines}
        onConsoleLine={recordConsoleLine}
        onClearConsole={() => setConsoleLines([])}
        onFixConsole={fixConsoleErrors}
        running={streaming}
        onRefresh={() => toast.toast('已重新载入预览')}
        onClose={() => setWorkbenchOpen(false)}
        activeTab={tab}
        onTabChange={setTab}
        activeArtifactName={selectedArtifactName}
        onSelectArtifact={(artifact) => { setSelectedArtifactName(artifact?.name || null); setConsoleLines([]); setTab('preview'); }}
        onSubmitArtifact={(entryName) => submitWork(entryName)}
        submittedNames={submittedNames}
        resolveAttachment={resolveAttachmentImage}
        onDownloadArtifact={(artifact) => {
          saveArtifact({ api, conversationId, artifact })
            .then(() => toast.ok(`已下载 ${artifact.name}`))
            .catch((error) => toast.error(error?.message || '下载失败'));
        }}
      /> : null}

      {editing ? (
        <div className="c-dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditing(null); }}>
          <div className="c-dialog" role="dialog" aria-modal="true" aria-label="编辑这条消息">
            <h3>改一下你刚才说的话</h3>
            <p>保存后 AI 会重新回答，原来的回答会被替换。</p>
            <textarea
              className="c-input c-dialog__textarea"
              value={editing.content}
              rows={4}
              autoFocus
              aria-label="消息内容"
              onChange={(event) => setEditing({ ...editing, content: event.target.value })}
            />
            <div className="c-dialog__actions">
              <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
              <Button variant="primary" disabled={streaming || !String(editing.content || '').trim()} onClick={submitEdit}>保存并重新回答</Button>
            </div>
          </div>
        </div>
      ) : null}

      {menu ? (
        <PopoverMenu
          anchor={menu.anchor}
          label={`「${menu.session.title}」的操作`}
          onClose={() => setMenu(null)}
          items={[
            { key: 'pin', label: menu.session.pinned ? '取消置顶' : '置顶', icon: 'pin', onSelect: () => togglePin(menu.session) },
            { key: 'rename', label: '重命名', icon: 'edit', onSelect: () => renameConversation(menu.session) },
            { key: 'sep', type: 'sep' },
            { key: 'delete', label: '删除对话', icon: 'trash', danger: true, onSelect: () => removeConversation(menu.session) },
          ]}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.title}
        body={confirm?.body}
        input={confirm?.input}
        tone={confirm?.tone}
        confirmLabel={confirm?.confirmLabel}
        cancelLabel="取消"
        onConfirm={confirm?.onConfirm}
        onCancel={() => setConfirm(null)}
      />
    </ConsoleShell>
  );
}

/* ── 对外导出 ────────────────────────────────────────────────────────────────
   包一层 [data-console] + ToastProvider：控制台令牌必须在这个子树里才拿得到，
   Toast 宿主也得挂在里面才能用上深色样式。.c-root 是 display:contents，
   不产生额外盒子，所以不会影响 ConsoleShell 的 100dvh 布局。 */
export function VibeCodingClassroom(props) {
  return (
    <div className="c-root" data-console="vibecoding">
      <ToastProvider><ClassroomView {...props} /></ToastProvider>
    </div>
  );
}

export function VibeCodingWorkspace(props) {
  return (
    <div className="c-root" data-console="vibecoding">
      <ToastProvider><WorkspaceView {...props} /></ToastProvider>
    </div>
  );
}
