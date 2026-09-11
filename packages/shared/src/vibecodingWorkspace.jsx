// VibeCoding 课堂：课程入口 + 对话式创作工作区。
//
// 工作区按 OpenSquilla 的控制台设计重建（见 console/ 目录与仓库根 THIRD-PARTY-NOTICES.md）：
// 左侧会话栏 / 中间对话流 / 右侧工作台（预览·源码·控制台）。学生不手写代码，
// 代码只有一个来源——AI 回复里带文件名的围栏，落到「产物」，在工作台里预览与查看。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Button, ConfirmDialog, ConsoleIcon, ConsoleEmpty, Pill, PopoverMenu, Spinner,
  ConsoleShell, ChatThread, Composer, Workbench, PreviewFrame, ToastProvider,
  useFollowScroll, useDockHeight, useWorkbenchWidth, useToast,
} from './console/index.js';
import { useData } from './classroom.jsx';
import { buildPreviewDocument, downloadTextFile } from './vibecodingProject.js';
import { consumeVibeCodingStream } from './vibecodingStream.js';
import { relativeTime } from './console/format.js';

// 兼容旧引用：官网作品页此前直接从本文件取 VibePreviewFrame
export const VibePreviewFrame = PreviewFrame;

const DEFAULT_TITLE = '新的创作对话';

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

function downloadArtifact(artifact) {
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
      const existing = byLesson.get(lesson.id);
      if (existing) { target(existing.id); return; }
      const created = await api.post('student/vibecoding/conversations', {
        lessonId: lesson.id, classId: lesson.classId, title: `${lesson.title || '今日课堂'} · 创作对话`,
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
          <p className="c-page__sub">你用说话描述想要什么，AI 把页面写出来，右边立刻能玩。</p>
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
              const existing = byLesson.get(lesson.id);
              const startable = Boolean(lesson.canStartVibeCoding);
              return (
                <article
                  className={`c-card c-fade-item c-lesson${startable ? '' : ' is-locked'}`}
                  key={lesson.id}
                  style={{ '--i': index }}
                >
                  <div className="c-lesson__top">
                    <span className="c-lesson__no">{String(lesson.sort).padStart(2, '0')}</span>
                    {startable ? <Pill tone="ok">已开课</Pill> : <Pill tone="warn">未开课</Pill>}
                  </div>
                  <h3 className="c-lesson__title">{lesson.title}</h3>
                  <p className="c-lesson__summary">{lesson.summary || '本节课的创作任务会显示在这里。'}</p>
                  <div className="c-lesson__meta">
                    {lesson.className || '未配置班级'} · {lesson.teacherName || '待分配老师'}
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
  const toast = useToast();

  const [search, setSearch] = useState('');
  const conversation = useData(() => api.get(`student/vibecoding/conversations/${conversationId}`), [api, conversationId]);
  const list = useData(() => api.get(`student/vibecoding/conversations?limit=50${search ? `&search=${encodeURIComponent(search)}` : ''}`), [api, conversationId, search]);

  const [messages, setMessages] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [consoleLines, setConsoleLines] = useState([]);
  const [tab, setTab] = useState('preview');
  const [workbenchOpen, setWorkbenchOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth > 720));
  const [editing, setEditing] = useState(null);
  const [menu, setMenu] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const abortRef = useRef(null);

  const workbench = useWorkbenchWidth();
  const dock = useDockHeight();
  const follow = useFollowScroll([
    messages.length,
    streaming,
    messages[messages.length - 1]?.content?.length || 0,
    messages[messages.length - 1]?.artifacts?.length || 0,
  ]);

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
    setConsoleLines([]);
  }, [conversation.data?.id, conversation.data?.updatedAt]);

  const editable = conversation.data?.status === 'DRAFT';
  const entryFile = useMemo(() => entryOf(artifacts, conversation.data?.entryFile), [artifacts, conversation.data?.entryFile]);
  const previewHtml = useMemo(() => buildPreviewDocument(filesFromArtifacts(artifacts), entryFile), [artifacts, entryFile]);

  if (conversation.loading) return <div className="c-page" data-console="vibecoding"><div className="c-page__center"><Spinner /> 正在打开创作工作区…</div></div>;
  if (conversation.error) return <div className="c-page" data-console="vibecoding"><div className="c-page__center"><ConsoleEmpty icon="alert" title="打开失败" body={conversation.error.message} /></div></div>;

  const data = conversation.data;

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
    setStreaming(true);
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
        onStatus: ({ chars }) => pushActivity(localId, { id: 'think', label: '推理中', detail: `已推理 ${chars} 字` }),
        onDelta: (_payload, full) => {
          answered = true;
          setMessages((current) => current.map((item) => (item.id === localId ? { ...item, content: full } : item)));
        },
        onArtifact: ({ artifact, created }) => {
          setArtifacts((current) => {
            const next = current.filter((item) => item.id !== artifact.id);
            return [...next, artifact];
          });
          setMessages((current) => current.map((item) => (item.id === localId
            ? { ...item, artifacts: [...(item.artifacts || []).filter((a) => a.id !== artifact.id), artifact] }
            : item)));
          pushActivity(localId, { id: `write-${artifact.name}`, label: created ? '新建文件' : '更新文件', detail: artifact.name });
          if (created) toast.ok(`写好了 ${artifact.name}`);
        },
        onDone: ({ message, artifacts: authoritative, elapsedMs }) => {
          setArtifacts(authoritative || []);
          setMessages((current) => current.map((item) => (item.id === localId
            ? { ...message, startedAt, elapsedMs, activity: item.activity, artifacts: (authoritative || []).filter((a) => a.messageId === message.id) }
            : item)));
        },
        onAborted: (_payload, full) => {
          setMessages((current) => current.map((item) => (item.id === localId ? { ...item, status: 'ABORTED', content: full } : item)));
        },
        onError: ({ message }) => {
          setMessages((current) => current.map((item) => (item.id === localId ? { ...item, status: 'FAILED', errorMessage: message } : item)));
        },
      });
      // 兜底：整轮没有 delta 也没有 error 时，别让消息永远停在「生成中」
      setMessages((current) => current.map((item) => (item.id === localId && item.status === 'STREAMING'
        ? { ...item, status: answered ? 'SUCCEEDED' : 'FAILED', errorMessage: answered ? undefined : 'AI 没有返回内容' }
        : item)));
      list.refresh();
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      setMessages((current) => current.map((item) => (item.id === localId
        ? { ...item, status: aborted ? 'ABORTED' : 'FAILED', errorMessage: aborted ? undefined : error.message }
        : item)));
      if (!aborted) toast.error(error.message || 'AI 回复失败');
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }

  function send(text) {
    const content = String(text ?? draft).trim();
    if (!content || streaming || !editable) return;
    setDraft('');
    streamReply('messages', { content }, {
      optimistic: [{ id: `local-user-${Date.now()}`, role: 'user', content, status: 'SUCCEEDED', createdAt: new Date().toISOString() }],
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
          await api.delete(`student/vibecoding/conversations/${conversationId}/messages`);
          setMessages([]);
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

  function submitWork() {
    if (!messages.length) return;
    setConfirm({
      title: '提交给老师点评？',
      body: '请确认这是你自己的作品，并同意平台在作品广场展示。提交后要等老师处理才能继续修改。',
      confirmLabel: '确认提交',
      onConfirm: async () => {
        setConfirm(null);
        try {
          await api.post(`student/vibecoding/conversations/${conversationId}/submit`, { copyrightConfirmed: true });
          toast.ok('作品已提交，等待老师点评');
          conversation.refresh();
          list.refresh();
        } catch (error) { toast.error(error.message || '提交失败'); }
      },
    });
  }

  async function runOnServer() {
    try {
      const result = await api.post(`student/vibecoding/conversations/${conversationId}/runs`, {});
      const run = result.run;
      const lines = [];
      if (run.stdout) lines.push({ level: 'log', text: run.stdout.trimEnd(), source: '服务端' });
      if (run.stderr) lines.push({ level: 'error', text: run.stderr.trimEnd(), source: '服务端' });
      lines.push({
        level: run.status === 'SUCCEEDED' ? 'info' : 'error',
        text: run.status === 'SUCCEEDED'
          ? `运行成功（退出码 ${run.exitCode}，${run.durationMs}ms）`
          : run.status === 'TIMEOUT'
            ? `运行超时（超过 ${Math.round((run.durationMs || 0) / 1000)} 秒已终止）`
            : `运行失败（退出码 ${run.exitCode}，${run.errorCode || '未知原因'}）`,
        source: '服务端',
      });
      setConsoleLines((current) => [...current, ...lines]);
    } catch (error) { toast.error(error.message || '运行失败'); }
  }

  const items = list.data?.items || [];
  const pinned = items.filter((item) => item.pinnedAt);
  const recent = items.filter((item) => !item.pinnedAt);
  const modelOptions = data.modelOptions || [];
  const submission = data.submission;
  const lastUserMessageId = [...messages].reverse().find((item) => item.role === 'user' && !String(item.id).startsWith('local-'))?.id || null;
  const sandboxAvailable = Boolean(data.sandbox?.available);

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
        ...(sandboxAvailable ? [] : [{ id: 'sandbox', label: '代码沙箱未启用', icon: 'shield', title: data.sandbox?.reason || '服务端代码运行当前不可用（用右侧预览看效果）' }]),
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
            <small>{data.className || '未配置班级'}</small>
          </div>
        </>
      )}
      title={data.title}
      subtitle={editable ? '正在创作' : '已提交'}
      actions={(
        <>
          {submission ? (
            <Pill tone={submission.status === 'APPROVED' ? 'ok' : submission.status === 'REJECTED' ? 'danger' : 'warn'}>
              {submission.status === 'APPROVED' ? '老师已通过' : submission.status === 'REJECTED' ? '已驳回' : '等待点评'}
            </Pill>
          ) : null}
          {modelOptions.length ? (
            <select
              className="c-input c-model-select"
              value={data.model || ''}
              disabled={!editable || streaming}
              aria-label="选择模型"
              title="本会话使用的模型"
              onChange={(event) => changeModel(event.target.value)}
            >
              <option value="">渠道默认模型</option>
              {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.displayName}</option>)}
            </select>
          ) : null}
          <Button size="sm" variant="ghost" icon="refresh" disabled={streaming || !messages.length || !editable} onClick={regenerate}>重新生成</Button>
          {workbenchOpen ? null : (
            <Button size="sm" variant="ghost" icon="eye" onClick={() => setWorkbenchOpen(true)}>预览作品</Button>
          )}
          <Button size="sm" variant="primary" icon="check" disabled={!editable || streaming || !messages.length} onClick={submitWork}>
            {editable ? '提交作品' : '已提交'}
          </Button>
        </>
      )}
    >
      <div className="c-content">
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
          onOpenArtifact={(artifact) => { setWorkbenchOpen(true); setTab('source'); setMenu(null); }}
          onDownloadArtifact={(artifact) => { downloadArtifact(artifact); toast.ok(`已下载 ${artifact.name}`); }}
          emptyState={(
            <div className="c-landing">
              <span className="c-landing__mark"><ConsoleIcon name="wand" size={24} /></span>
              <h2>和 AI 一起做东西</h2>
              <p>用一句话说清你想要什么，AI 会把页面写出来，右边立刻能玩。改主意了就直接说，它会接着改。</p>
              <div className="c-landing__prompts">
                {['做一个点击按钮会变色的网页', '写一个猜数字的小游戏', '做一个会跳动的爱心动画', '做一个能记录心情的小本子'].map((prompt) => (
                  <button key={prompt} type="button" className="c-landing__prompt" onClick={() => { setDraft(prompt); setTimeout(() => send(prompt), 0); }}>
                    {prompt}
                  </button>
                ))}
              </div>
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
            streaming={streaming}
            disabled={!editable}
            blockedReason={editable ? '' : '作品已提交，等老师点评后才能继续创作。'}
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
        artifacts={artifacts}
        previewHtml={previewHtml}
        consoleLines={consoleLines}
        running={streaming}
        onClearConsole={() => setConsoleLines([])}
        onRefresh={() => { setConsoleLines([]); toast.toast('已重新载入预览'); }}
        onClose={() => setWorkbenchOpen(false)}
        activeTab={tab}
        onTabChange={setTab}
        activeArtifactName={entryFile}
        onSelectArtifact={() => setTab('source')}
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
