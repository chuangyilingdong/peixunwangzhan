// VibeCoding 课堂：课程入口 + 对话式代码创作工作区（会话侧栏 / 聊天 / 代码与预览）。
// 预览用 sandbox="allow-scripts" 的 iframe 承载学生自己的 HTML/CSS/JS，与平台页面完全隔离。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState, Loading, Notice, Empty, PageHeader } from './ui.jsx';
import { useData } from './classroom.jsx';
import { MarkdownView } from './markdown.jsx';
import { formatDate } from './auth.js';
import { buildProjectBundle, buildPreviewDocument, downloadTextFile, parseProjectBundle, projectFileBase } from './vibecodingProject.js';

const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const TEXT_FILE_PATTERN = /\.(html?|css|m?js|json|txt|md|svg)$/i;
const MAX_SINGLE_FILE_BYTES = 64 * 1024;

function normalizeFiles(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).map(([key, content]) => [key, String(content ?? '')]));
}

// ── 工程导入导出 ────────────────────────────────────────────────────────────
function downloadProject(filename, content) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ── 课程入口 ────────────────────────────────────────────────────────────────
export function VibeCodingClassroom({ api, onEnterConversation }) {
  const navigate = useNavigate();
  const dashboard = useData(() => api.get('student/dashboard'), [api]);
  const conversations = useData(() => api.get('student/vibecoding/conversations?limit=50'), [api]);
  const [busy, setBusy] = useState(null);
  const [message, setMessage] = useState('');
  if (dashboard.loading) return <Loading label="正在读取 VibeCoding 课程…" />;
  if (dashboard.error) return <ErrorState error={dashboard.error} onRetry={dashboard.refresh} />;

  const courses = (dashboard.data?.classroomCourses || [])
    .map((course) => ({ ...course, lessons: (course.lessons || []).filter((lesson) => lesson.deliveryMode === 'VIBECODING') }))
    .filter((course) => course.lessons.length);
  const byLesson = new Map((conversations.data?.items || []).filter((item) => item.lessonId).map((item) => [item.lessonId, item]));

  async function enter(lesson) {
    if (!lesson.canStartVibeCoding) return;
    setBusy(lesson.id); setMessage('');
    try {
      const target = onEnterConversation || ((id) => navigate(`/learn/vibecoding/${id}`));
      const existing = byLesson.get(lesson.id);
      if (existing) { target(existing.id); return; }
      const created = await api.post('student/vibecoding/conversations', {
        lessonId: lesson.id, classId: lesson.classId, title: `${lesson.title || '今日课堂'} · 创作对话`,
      });
      target(created.id);
    } catch (error) { setMessage(error.message || '进入课堂失败'); } finally { setBusy(null); }
  }

  return <main className="classroom-center classroom-course-detail">
    <PageHeader eyebrow="VibeCoding 上课" title="选择一节课开始创作" description="和 AI 对话写代码，右侧预览里马上看到你的作品。" actions={<button className="secondary-button" onClick={() => { dashboard.refresh(); conversations.refresh(); }}>刷新</button>} />
    {message && <Notice tone="danger">{message}</Notice>}
    {courses.length ? courses.map((course) => <section className="lesson-detail-list" key={course.id} aria-label={`${course.title} VibeCoding 课时`}>
      <div className="lesson-list-heading"><div><span className="eyebrow">{course.title}</span><h2>选择一节课</h2></div><span className="muted">共 {course.lessons.length} 节</span></div>
      {course.lessons.map((lesson) => {
        const existing = byLesson.get(lesson.id);
        const startable = Boolean(lesson.canStartVibeCoding);
        return <article className={`lesson-detail-card ${startable ? 'is-open' : 'is-locked'}`} key={lesson.id}>
          <div className="lesson-number">{String(lesson.sort).padStart(2, '0')}</div>
          <div className="lesson-detail-main">
            <div className="lesson-detail-title-row">
              <div><span className="lesson-kicker">第 {lesson.sort} 节</span><h3>{lesson.title}</h3></div>
              {startable ? <span className="status success">已开课</span> : <span className="status warning">未开课</span>}
            </div>
            <p>{lesson.summary || '本节课的创作任务与课堂说明将在这里展示。'}</p>
            <div className="lesson-meta">{lesson.className || '未配置班级'} · {lesson.teacherName || '待分配老师'}{existing ? ` · 已有对话「${existing.title}」` : ''}</div>
          </div>
          <div className="lesson-detail-action">
            <span className="lesson-block-reason">{lesson.vibeCodingBlockReason || (existing ? '可以继续上次的创作对话。' : '开始一节新的创作对话。')}</span>
            <button className={startable ? 'primary-button' : 'secondary-button'} disabled={!startable || busy === lesson.id} onClick={() => enter(lesson)}>
              {busy === lesson.id ? '正在进入…' : existing ? '继续创作' : '进入创作'}
            </button>
          </div>
        </article>;
      })}
    </section>) : <Empty title="暂无 VibeCoding 课时" body="老师在课程包里把课时设为 VibeCoding 课堂后，这里会显示。" />}
  </main>;
}

// ── 创作工作区 ──────────────────────────────────────────────────────────────
export function VibeCodingWorkspace({ api }) {
  const navigate = useNavigate();
  const params = useParams();
  const conversationId = params?.conversationId;
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const conversation = useData(() => api.get(`student/vibecoding/conversations/${conversationId}`), [api, conversationId]);
  const list = useData(() => api.get(`student/vibecoding/conversations?limit=50${search ? `&search=${encodeURIComponent(search)}` : ''}`), [api, conversationId, search]);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [files, setFiles] = useState({});
  const [entryFile, setEntryFile] = useState('index.html');
  const [activeFile, setActiveFile] = useState('');
  const [dirty, setDirty] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [consoleLines, setConsoleLines] = useState([]);
  const [runBusy, setRunBusy] = useState(false);
  const [sandbox, setSandbox] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [thinkingChars, setThinkingChars] = useState(0);
  const [editing, setEditing] = useState(null);
  const messageEndRef = useRef(null);
  const importInputRef = useRef(null);
  const uploadInputRef = useRef(null);
  const abortRef = useRef(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);

  const sandboxInfo = useData(() => api.get('student/vibecoding/sandbox'), [api]);
  useEffect(() => { setSandbox(sandboxInfo.data || null); }, [sandboxInfo.data]);

  // 搜索防抖：输入停下来再请求
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // 「更多」菜单：点外面收起
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event) => { if (moreRef.current && !moreRef.current.contains(event.target)) setMoreOpen(false); };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [moreOpen]);

  // 预览 iframe 的控制台输出：只能通过 postMessage 桥接出来
  useEffect(() => {
    function onMessage(event) {
      const payload = event?.data;
      if (!payload || payload.source !== 'vibecoding-console') return;
      setConsoleLines((current) => [...current.slice(-199), { level: payload.level || 'log', text: String(payload.text || ''), source: '浏览器' }]);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (!conversation.data) return;
    setMessages(conversation.data.messages || []);
    const nextFiles = normalizeFiles(conversation.data.files);
    setFiles(nextFiles);
    setEntryFile(conversation.data.entryFile || 'index.html');
    setActiveFile(conversation.data.entryFile || Object.keys(nextFiles)[0] || '');
    setDirty(false);
    setEditing(null);
  }, [conversation.data?.id, conversation.data?.updatedAt]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [messages.length, streaming]);

  const previewDocument = useMemo(() => buildPreviewDocument(files, entryFile), [files, entryFile]);

  if (conversation.loading) return <Loading label="正在打开创作工作区…" />;
  if (conversation.error) return <ErrorState error={conversation.error} onRetry={conversation.refresh} />;
  const data = conversation.data;
  const editable = data.status === 'DRAFT';

  /**
   * 统一的流式回复：发送 / 重新生成 / 编辑重发都走这里。
   * 支持停止（abort 会同时断开服务端的上游请求，不扣积分）、思考进度、停止与失败态渲染。
   */
  async function streamReply(route, body, { optimistic = [] } = {}) {
    setStreaming(true); setMessage(''); setThinkingChars(0);
    const assistantId = `local-assistant-${Date.now()}`;
    setMessages((current) => [...current, ...optimistic,
      { id: assistantId, role: 'assistant', content: '', status: 'STREAMING', createdAt: new Date().toISOString() },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await api.stream(`student/vibecoding/conversations/${conversationId}/${route}`, { body, signal: controller.signal });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = ''; let answer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const eventLine = block.split('\n').find((line) => line.startsWith('event:')) || '';
          const dataLine = block.split('\n').find((line) => line.startsWith('data:')) || '';
          const type = eventLine.slice(6).trim();
          let payload = {};
          try { payload = JSON.parse(dataLine.slice(5).trim() || '{}'); } catch { payload = {}; }
          if (type === 'thinking') {
            setThinkingChars(Number(payload.chars) || 0);
          } else if (type === 'delta') {
            answer += payload.delta || '';
            setMessages((current) => current.map((item) => (item.id === assistantId ? { ...item, content: answer } : item)));
          } else if (type === 'done') {
            setMessages((current) => current.map((item) => (item.id === assistantId ? { ...payload.message } : item)));
          } else if (type === 'aborted') {
            setMessages((current) => current.map((item) => (item.id === assistantId ? { ...item, status: 'ABORTED', content: answer } : item)));
          } else if (type === 'error') {
            setMessages((current) => current.map((item) => (item.id === assistantId ? { ...item, status: 'FAILED', content: answer, errorCode: payload.code, errorMessage: payload.message } : item)));
            setMessage(payload.message || 'AI 回复失败');
          }
        }
      }
      list.refresh();
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      setMessages((current) => current.map((item) => (item.id === assistantId
        ? { ...item, status: aborted ? 'ABORTED' : 'FAILED', errorMessage: aborted ? '已停止生成' : error.message }
        : item)));
      if (!aborted) setMessage(error.message || 'AI 回复失败');
    } finally {
      abortRef.current = null;
      setStreaming(false);
      setThinkingChars(0);
    }
  }

  async function send(event) {
    event.preventDefault();
    const content = input.trim();
    if (!content || streaming || !editable) return;
    setInput('');
    await streamReply('messages', { content }, {
      optimistic: [{ id: `local-user-${Date.now()}`, role: 'user', content, status: 'SUCCEEDED', createdAt: new Date().toISOString() }],
    });
  }

  function stopStreaming() { abortRef.current?.abort(); }

  async function regenerate() {
    if (streaming || !editable) return;
    setMessages((current) => { const next = [...current]; while (next.length && next[next.length - 1].role === 'assistant') next.pop(); return next; });
    await streamReply('messages/regenerate', {});
  }

  async function submitEdit() {
    if (!editing || streaming) return;
    const content = String(editing.content || '').trim();
    const messageId = editing.id;
    if (!content) { setEditing(null); return; }
    setEditing(null);
    setMessages((current) => {
      const next = [...current];
      const index = next.findIndex((item) => item.id === messageId);
      if (index >= 0) { next[index] = { ...next[index], content }; next.length = index + 1; }
      return next;
    });
    await streamReply(`messages/${messageId}/edit`, { content });
  }

  async function deleteMessage(messageId) {
    if (streaming || !editable) return;
    if (!window.confirm('删除这条消息？（它之后的回答会一起删掉）')) return;
    try {
      await api.delete(`student/vibecoding/conversations/${conversationId}/messages/${messageId}`);
      setMessages((current) => { const index = current.findIndex((item) => item.id === messageId); return index < 0 ? current : current.slice(0, index); });
    } catch (error) { setMessage(error.message || '删除失败'); }
  }

  async function clearMessages() {
    if (streaming || !editable || !messages.length) return;
    if (!window.confirm('清空这个会话的全部聊天记录？代码文件会保留。')) return;
    try {
      await api.delete(`student/vibecoding/conversations/${conversationId}/messages`);
      setMessages([]);
      setMessage('聊天记录已清空。');
    } catch (error) { setMessage(error.message || '清空失败'); }
  }

  // AI 回复里「```语言 文件名」的代码块可一键写入工程文件（覆盖前学生确认）
  function applyCodeToFile(name, code) {
    if (!editable) return;
    const exists = files[name] !== undefined;
    if (exists && !window.confirm(`用 AI 给的代码覆盖 ${name}？`)) return;
    updateFile(name, code);
    setActiveFile(name);
    setMessage(`已写入 ${name}，记得点「保存代码」。`);
  }

  // 上传文本类文件到工程（老师给的起始文件等）；二进制文件不支持
  async function uploadFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const name = String(file.name || '').replace(/^\/+/, '');
    if (!FILE_NAME_PATTERN.test(name) || name.includes('..') || !TEXT_FILE_PATTERN.test(name)) { setMessage('只支持 html / css / js / json / txt / md / svg 文件'); return; }
    if (file.size > MAX_SINGLE_FILE_BYTES) { setMessage('单个文件不能超过 64KB'); return; }
    try {
      const text = await file.text();
      if (files[name] !== undefined && !window.confirm(`已存在 ${name}，覆盖它？`)) return;
      updateFile(name, text);
      setActiveFile(name);
      setMessage(`已加入 ${name}，记得点「保存代码」。`);
    } catch (error) { setMessage(error.message || '读取文件失败'); }
  }

  async function togglePin(item) {
    try { await api.put(`student/vibecoding/conversations/${item.id}/pin`, { pinned: !item.pinnedAt }); list.refresh(); }
    catch (error) { setMessage(error.message || '置顶失败'); }
  }

  async function changeModel(nextModel) {
    try { await api.put(`student/vibecoding/conversations/${conversationId}`, { model: nextModel }); conversation.refresh(); list.refresh(); }
    catch (error) { setMessage(error.message || '切换模型失败'); }
  }

  function exportTranscript() {
    const lines = [`# ${data.title}`, '', `课时：${data.lessonTitle || '—'}`, `导出时间：${new Date().toLocaleString('zh-CN')}`, ''];
    for (const item of messages) lines.push(`## ${item.role === 'user' ? '学生' : 'AI 助手'}（${formatDate(item.createdAt)}）`, '', item.content || '（无内容）', '');
    downloadTextFile(`${projectFileBase(data.title)}.对话.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
    setMessage('对话记录已导出。');
  }

  function updateFile(name, value) {
    setFiles((current) => ({ ...current, [name]: value }));
    setDirty(true);
  }

  async function saveFiles() {
    setBusy(true); setMessage('');
    try {
      const saved = await api.put(`student/vibecoding/conversations/${conversationId}`, { files, entryFile });
      setFiles(normalizeFiles(saved.files));
      setDirty(false);
      setMessage('代码已保存。');
    } catch (error) { setMessage(error.message || '保存失败'); } finally { setBusy(false); }
  }

  async function addFile() {
    const name = window.prompt('新文件名（例如 app.js / style.css）', '');
    if (!name) return;
    const clean = name.trim().replace(/^\/+/, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(clean) || clean.includes('..')) { setMessage('文件名不合法'); return; }
    if (files[clean] !== undefined) { setActiveFile(clean); return; }
    updateFile(clean, '');
    setActiveFile(clean);
  }

  async function submitWork() {
    if (!window.confirm('提交给老师点评前请确认：这是你自己的作品，并同意平台在作品广场展示。\n提交后需要等老师处理才能继续修改。')) return;
    setBusy(true); setMessage('');
    try {
      await api.post(`student/vibecoding/conversations/${conversationId}/submit`, { copyrightConfirmed: true });
      setMessage('作品已提交，等待老师点评。');
      conversation.refresh(); list.refresh();
    } catch (error) { setMessage(error.message || '提交失败'); } finally { setBusy(false); }
  }

  async function renameConversation() {
    const title = window.prompt('会话名称', data.title || '');
    if (title === null) return;
    try { await api.put(`student/vibecoding/conversations/${conversationId}`, { title: title.trim() || data.title }); conversation.refresh(); list.refresh(); }
    catch (error) { setMessage(error.message || '重命名失败'); }
  }

  async function removeConversation() {
    if (!window.confirm('删除这个创作对话？代码和聊天记录都会删除。')) return;
    try { await api.delete(`student/vibecoding/conversations/${conversationId}`); navigate('/learn/vibecoding'); }
    catch (error) { setMessage(error.message || '删除失败'); }
  }

  async function createConversation() {
    try {
      const created = await api.post('student/vibecoding/conversations', { lessonId: data.lessonId, classId: data.classId, title: '新的创作对话' });
      navigate(`/learn/vibecoding/${created.id}`);
    } catch (error) { setMessage(error.message || '新建失败'); }
  }

  function exportProject() {
    const bundle = buildProjectBundle({ title: data.title, entryFile, files });
    downloadProject(`${projectFileBase(data.title)}.vibecoding.json`, JSON.stringify(bundle, null, 2));
    setMessage('工程文件已导出。');
  }

  async function importProject(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed = parseProjectBundle(await file.text());
      if (Object.keys(files).length && !window.confirm('导入会覆盖当前会话的代码（未保存的修改会丢失），继续？')) return;
      setFiles(parsed.files);
      setEntryFile(parsed.entryFile);
      setActiveFile(parsed.entryFile);
      setDirty(true);
      setConsoleLines([]);
      setPreviewKey((value) => value + 1);
      setMessage('工程已导入，点「保存代码」写入这个会话。');
    } catch (error) {
      setMessage(error.message || '导入失败');
    }
  }

  function runPreview() {
    setConsoleLines([]);
    setPreviewKey((value) => value + 1);
  }

  async function runOnServer() {
    setRunBusy(true); setMessage('');
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
    } catch (error) { setMessage(error.message || '运行失败'); } finally { setRunBusy(false); }
  }

  const fileNames = Object.keys(files).sort((a, b) => (a === entryFile ? -1 : b === entryFile ? 1 : a.localeCompare(b)));
  const conversationItems = list.data?.items || [];
  const pinnedItems = conversationItems.filter((item) => item.pinnedAt);
  const recentItems = conversationItems.filter((item) => !item.pinnedAt);
  const lastUserMessageId = [...messages].reverse().find((item) => item.role === 'user' && !String(item.id).startsWith('local-'))?.id || null;
  const lastAssistantId = messages.length && messages[messages.length - 1].role === 'assistant' ? messages[messages.length - 1].id : null;
  const modelOptions = data.modelOptions || [];

  return <main className="vb-shell">
    <header className="vb-topbar">
      <div className="vb-brand"><span className="vb-brand__mark">✦</span><div><strong>AI 魔法学院</strong><small>VibeCoding 创作课堂</small></div></div>
      <div className="vb-topbar__title"><span>{editable ? '正在上课' : '已提交'}</span><strong>{data.lessonTitle || 'VibeCoding 课堂'}</strong></div>
      <div className="vb-topbar__actions">
        {modelOptions.length ? <label className="vb-model">模型
          <select value={data.model || ''} disabled={!editable || streaming} onChange={(event) => changeModel(event.target.value)}>
            <option value="">渠道默认</option>
            {modelOptions.map((option) => <option key={option.id} value={option.id}>{option.displayName}</option>)}
          </select>
        </label> : null}
        <button className="ghost-canvas-button" type="button" onClick={() => navigate('/learn/vibecoding')}>课程大厅</button>
        <button className="secondary-button" type="button" disabled={busy || !dirty} onClick={saveFiles}>{busy ? '保存中…' : dirty ? '保存代码' : '已保存'}</button>
        <button className="primary-canvas-button" type="button" disabled={!editable || busy || !messages.length} onClick={submitWork}>{editable ? '提交作品 ✨' : '已提交'}</button>
      </div>
    </header>

    {data.submission ? <div className={`vb-submission is-${data.submission.status.toLowerCase()}`}>
      <strong>{data.submission.status === 'PENDING' ? '已提交，等待老师点评' : data.submission.status === 'APPROVED' ? '老师已通过这个作品' : '老师驳回了这个作品，可以继续修改后重新提交'}</strong>
      {data.submission.teacherComment ? <p>老师点评：{data.submission.teacherComment}</p> : null}
      <small>第 {data.submission.round} 次提交 · {formatDate(data.submission.submittedAt)}</small>
    </div> : null}

    <section className="vb-layout">
      <aside className="vb-sidebar">
        <button className="vb-new-button" type="button" onClick={createConversation}>＋ 新建对话</button>
        <input className="vb-sidebar__search" value={searchInput} placeholder="搜索对话…" onChange={(event) => setSearchInput(event.target.value)} aria-label="搜索对话" />
        {pinnedItems.length ? <><div className="vb-sidebar__heading">置顶</div><ul className="vb-conversation-list">{pinnedItems.map((item) => <li key={item.id} className={item.id === conversationId ? 'is-active' : ''}>
          <button type="button" onClick={() => navigate(`/learn/vibecoding/${item.id}`)}><strong>📌 {item.title}</strong><small>{formatDate(item.lastMessageAt || item.createdAt)}</small></button>
          <button type="button" className="vb-conversation-list__pin" title="取消置顶" onClick={() => togglePin(item)}>★</button>
        </li>)}</ul></> : null}
        <div className="vb-sidebar__heading">最近</div>
        <ul className="vb-conversation-list">
          {recentItems.map((item) => <li key={item.id} className={item.id === conversationId ? 'is-active' : ''}>
            <button type="button" onClick={() => navigate(`/learn/vibecoding/${item.id}`)}><strong>{item.title}</strong><small>{formatDate(item.lastMessageAt || item.createdAt)}</small></button>
            <button type="button" className="vb-conversation-list__pin" title="置顶" onClick={() => togglePin(item)}>☆</button>
          </li>)}
        </ul>
        {!conversationItems.length ? <p className="muted">没有匹配的对话。</p> : null}
        <div className="vb-sidebar__actions">
          <button className="text-button" type="button" onClick={renameConversation} disabled={!editable}>重命名</button>
          <button className="text-button" type="button" onClick={clearMessages} disabled={!editable || !messages.length}>清空记录</button>
          <button className="text-button" type="button" onClick={removeConversation}>删除</button>
        </div>
      </aside>

      <div className="vb-chat">
        <div className="vb-messages">
          {messages.length ? messages.map((item) => <div className={`vb-message vb-message--${item.role}`} key={item.id}>
            <div className="vb-message__avatar">{item.role === 'user' ? '我' : 'AI'}</div>
            <div className="vb-message__body">
              {item.role === 'assistant'
                ? (item.content
                  ? <MarkdownView content={item.content} onApplyFile={editable ? applyCodeToFile : null} />
                  : <p className="muted">{item.status === 'STREAMING' ? (thinkingChars ? `正在思考…（已推理 ${thinkingChars} 字）` : '正在思考…') : item.status === 'ABORTED' ? '已停止生成' : '（没有内容）'}</p>)
                : (editing?.id === item.id
                  ? <div className="vb-message__edit">
                    <textarea value={editing.content} rows={3} onChange={(event) => setEditing({ ...editing, content: event.target.value })} />
                    <div className="row-actions"><button className="primary-canvas-button" type="button" disabled={streaming || !String(editing.content || '').trim()} onClick={submitEdit}>保存并重新回答</button><button className="secondary-button" type="button" onClick={() => setEditing(null)}>取消</button></div>
                  </div>
                  : <p>{item.content}</p>)}
              {item.status === 'STREAMING' ? <span className="vb-cursor" /> : null}
              {item.status === 'STREAMING' && thinkingChars ? <div className="vb-thinking">AI 正在推理，已经想了 {thinkingChars} 个字，马上开始写答案…</div> : null}
              {item.status === 'ABORTED' ? <p className="muted">已停止生成（没有扣积分）。</p> : null}
              {item.status === 'FAILED' ? <p className="vb-message__error">{item.errorMessage || item.errorCode || 'AI 回复失败'}</p> : null}
              {!streaming && editable ? <div className="vb-message__actions">
                {item.role === 'user' && item.id === lastUserMessageId ? <button type="button" className="text-button" onClick={() => setEditing({ id: item.id, content: item.content })}>编辑</button> : null}
                {item.role === 'assistant' && item.id === lastAssistantId ? <button type="button" className="text-button" onClick={regenerate}>重新生成</button> : null}
                {!String(item.id).startsWith('local-') ? <button type="button" className="text-button" onClick={() => deleteMessage(item.id)}>删除</button> : null}
              </div> : null}
            </div>
          </div>) : <div className="vb-chat-empty">
            <h2>和 AI 一起写代码</h2>
            <p>例如：「做一个点击按钮会变色的网页」「帮我写一个猜数字小游戏」。</p>
          </div>}
          <div ref={messageEndRef} />
        </div>
        <form className="vb-composer" onSubmit={send}>
          <textarea value={input} maxLength={4000} rows={3} placeholder={editable ? '说说你想做什么…（Enter 发送，Shift+Enter 换行）' : '会话已提交，不能再继续对话'} disabled={!editable || streaming}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(event); } }} />
          {streaming
            ? <button className="secondary-button" type="button" onClick={stopStreaming}>停止生成</button>
            : <button className="primary-canvas-button" type="submit" disabled={!editable || !input.trim()}>发送</button>}
        </form>
      </div>

      <aside className="vb-code">
        <div className="vb-code__tabs">
          {fileNames.map((name) => <button key={name} type="button" className={name === activeFile ? 'is-active' : ''} onClick={() => setActiveFile(name)}>{name}</button>)}
          <button type="button" className="vb-code__add" onClick={addFile} disabled={!editable}>＋</button>
        </div>
        <textarea className="vb-code__editor" spellCheck={false} value={files[activeFile] ?? ''} disabled={!editable}
          onChange={(event) => updateFile(activeFile, event.target.value)} />
        <div className="vb-code__actions">
          <label className="vb-code__entry">入口文件
            <select value={entryFile} onChange={(event) => { setEntryFile(event.target.value); setDirty(true); }} disabled={!editable}>
              {fileNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <div className="row-actions vb-code__primary">
            <button className="secondary-button" type="button" onClick={runPreview}>重新运行</button>
            {sandbox?.available ? <button className="secondary-button" type="button" disabled={runBusy}
              title="在服务器隔离沙箱里运行入口 JS 文件"
              onClick={runOnServer}>{runBusy ? '运行中…' : '服务端运行'}</button> : null}
            <div className="vb-more" ref={moreRef}>
              <button className="secondary-button" type="button" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}>⋯ 更多</button>
              {moreOpen ? <div className="vb-more__menu" role="menu">
                <button type="button" role="menuitem" disabled={!editable} onClick={() => { setMoreOpen(false); uploadInputRef.current?.click(); }}>上传文件到工程</button>
                <button type="button" role="menuitem" disabled={!editable} onClick={() => { setMoreOpen(false); importInputRef.current?.click(); }}>导入工程（JSON）</button>
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); exportProject(); }}>导出工程</button>
                <button type="button" role="menuitem" disabled={!messages.length} onClick={() => { setMoreOpen(false); exportTranscript(); }}>导出对话记录</button>
              </div> : null}
            </div>
            <input ref={importInputRef} className="vb-file-input" type="file" accept=".json,application/json" onChange={importProject} aria-label="导入工程文件" />
            <input ref={uploadInputRef} className="vb-file-input" type="file" accept=".html,.htm,.css,.js,.mjs,.json,.txt,.md,.svg" onChange={uploadFile} aria-label="上传文件到工程" />
          </div>
        </div>
        <VibePreviewFrame key={previewKey} className="vb-preview" html={previewDocument} />
        <div className="vb-console">
          <div className="vb-console__head"><span>控制台</span><button type="button" className="text-button" onClick={() => setConsoleLines([])} disabled={!consoleLines.length}>清空</button></div>
          <div className="vb-console__body">
            {consoleLines.length ? consoleLines.map((line, index) => <div key={index} className={`vb-console__line is-${line.level}`}><span>{line.source}</span>{line.text}</div>) : <p className="muted">运行后这里会显示输出。{sandbox && sandbox.available === false ? '服务端运行当前不可用。' : ''}</p>}
          </div>
        </div>
      </aside>
    </section>

    {message && <div className="student-canvas-toast">{message}</div>}
  </main>;
}

// ── 学生代码预览外壳 ────────────────────────────────────────────────────────
// 直接 srcdoc 会被主站 CSP（script-src 'self'）拦掉内联脚本，所以把学生页面
// postMessage 给 /vibe-preview.html（nginx 单独给它的宽松 CSP），由它写进内层 sandbox iframe。
export function VibePreviewFrame({ html, className = '', title = '预览' }) {
  const frameRef = useRef(null);
  const [ready, setReady] = useState(0);
  useEffect(() => {
    function onMessage(event) {
      if (event.data && event.data.source === 'vibecoding-preview-ready') setReady((value) => value + 1);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ source: 'vibecoding-preview', html: String(html || '') }, '*');
  }, [html, ready]);
  return <iframe ref={frameRef} className={className} title={title} sandbox="allow-scripts" src="/vibe-preview.html" />;
}
