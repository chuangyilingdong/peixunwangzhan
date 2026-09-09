// VibeCoding 课堂：课程入口 + 对话式代码创作工作区（会话侧栏 / 聊天 / 代码与预览）。
// 预览用 sandbox="allow-scripts" 的 iframe 承载学生自己的 HTML/CSS/JS，与平台页面完全隔离。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ErrorState, Loading, Notice, Empty, PageHeader } from './ui.jsx';
import { useData } from './classroom.jsx';
import { MarkdownView } from './markdown.jsx';
import { formatDate } from './auth.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

// 预览文档里注入控制台桥：沙箱 iframe 不能同源读 DOM，但可以 postMessage 给父页面。
const CONSOLE_BRIDGE = `<script>(function(){
  var send=function(level,args){try{parent.postMessage({source:'vibecoding-console',level:level,text:args.map(function(item){try{return typeof item==='string'?item:JSON.stringify(item);}catch(e){return String(item);}}).join(' ')},'*');}catch(e){}};
  ['log','info','warn','error'].forEach(function(level){var original=console[level]?console[level].bind(console):function(){};console[level]=function(){var args=[].slice.call(arguments);send(level,args);original.apply(null,args);};});
  window.addEventListener('error',function(event){send('error',[event.message+'（第 '+event.lineno+' 行）']);});
  window.addEventListener('unhandledrejection',function(event){send('error',['未处理的异步错误：'+(event.reason&&event.reason.message?event.reason.message:event.reason)]);});
})();</script>`;

// 把入口 HTML 里引用的本地 css/js 内联进预览文档；外链保持原样（sandbox 内没有同源权限）。
function buildPreviewDocument(files, entryFile) {
  const entry = files?.[entryFile];
  if (entry === undefined) return '<!doctype html><html><body style="font-family:sans-serif;padding:16px">入口文件不存在</body></html>';
  if (!/\.html?$/i.test(entryFile)) return `<!doctype html><html><body><pre style="font-family:monospace;padding:12px">${escapeHtml(entry)}</pre></body></html>`;
  const resolve = (name) => {
    const clean = String(name || '').replace(/^\.\//, '');
    return files[clean] !== undefined ? files[clean] : files[name];
  };
  const html = String(entry)
    .replace(/<link[^>]*href=["']([^"']+)["'][^>]*>/gi, (match, href) => (resolve(href) !== undefined ? `<style>${resolve(href)}</style>` : match))
    .replace(/<script[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (match, src) => (resolve(src) !== undefined ? `<script>${resolve(src)}</script>` : match));
  // 桥必须装在学生脚本之前，否则早期 console 调用抓不到：优先塞进 head。
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${CONSOLE_BRIDGE}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (match) => `${match}${CONSOLE_BRIDGE}`);
  return CONSOLE_BRIDGE + html;
}

function normalizeFiles(value) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(Object.entries(value).map(([key, content]) => [key, String(content ?? '')]));
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
  const conversation = useData(() => api.get(`student/vibecoding/conversations/${conversationId}`), [api, conversationId]);
  const list = useData(() => api.get('student/vibecoding/conversations?limit=50'), [api, conversationId]);

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
  const messageEndRef = useRef(null);

  const sandboxInfo = useData(() => api.get('student/vibecoding/sandbox'), [api]);
  useEffect(() => { setSandbox(sandboxInfo.data || null); }, [sandboxInfo.data]);

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
  }, [conversation.data?.id, conversation.data?.updatedAt]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [messages.length, streaming]);

  const previewDocument = useMemo(() => buildPreviewDocument(files, entryFile), [files, entryFile]);

  if (conversation.loading) return <Loading label="正在打开创作工作区…" />;
  if (conversation.error) return <ErrorState error={conversation.error} onRetry={conversation.refresh} />;
  const data = conversation.data;
  const editable = data.status === 'DRAFT';

  async function send(event) {
    event.preventDefault();
    const content = input.trim();
    if (!content || streaming || !editable) return;
    setInput(''); setStreaming(true); setMessage('');
    const assistantId = `local-assistant-${Date.now()}`;
    setMessages((current) => [...current,
      { id: `local-user-${Date.now()}`, role: 'user', content, status: 'SUCCEEDED', createdAt: new Date().toISOString() },
      { id: assistantId, role: 'assistant', content: '', status: 'STREAMING', createdAt: new Date().toISOString() },
    ]);
    try {
      const response = await api.stream(`student/vibecoding/conversations/${conversationId}/messages`, { body: { content } });
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
          if (type === 'delta') {
            answer += payload.delta || '';
            setMessages((current) => current.map((item) => (item.id === assistantId ? { ...item, content: answer } : item)));
          } else if (type === 'done') {
            setMessages((current) => current.map((item) => (item.id === assistantId ? { ...payload.message } : item)));
          } else if (type === 'error') {
            setMessages((current) => current.map((item) => (item.id === assistantId ? { ...item, status: 'FAILED', content: answer, errorCode: payload.code, errorMessage: payload.message } : item)));
            setMessage(payload.message || 'AI 回复失败');
          }
        }
      }
      list.refresh();
    } catch (error) {
      setMessages((current) => current.map((item) => (item.id === assistantId ? { ...item, status: 'FAILED', errorMessage: error.message } : item)));
      setMessage(error.message || 'AI 回复失败');
    } finally {
      setStreaming(false);
    }
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
    if (!window.confirm('提交这个作品给老师点评？提交后需要等老师处理才能继续修改。')) return;
    setBusy(true); setMessage('');
    try {
      await api.post(`student/vibecoding/conversations/${conversationId}/submit`, {});
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

  return <main className="vb-shell">
    <header className="vb-topbar">
      <div className="vb-brand"><span className="vb-brand__mark">✦</span><div><strong>AI 魔法学院</strong><small>VibeCoding 创作课堂</small></div></div>
      <div className="vb-topbar__title"><span>{editable ? '正在上课' : '已提交'}</span><strong>{data.lessonTitle || 'VibeCoding 课堂'}</strong></div>
      <div className="vb-topbar__actions">
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
        <div className="vb-sidebar__heading">我的创作对话</div>
        <ul className="vb-conversation-list">
          {(list.data?.items || []).map((item) => <li key={item.id} className={item.id === conversationId ? 'is-active' : ''}>
            <button type="button" onClick={() => navigate(`/learn/vibecoding/${item.id}`)}>
              <strong>{item.title}</strong>
              <small>{formatDate(item.lastMessageAt || item.createdAt)}</small>
            </button>
          </li>)}
        </ul>
        <div className="vb-sidebar__actions">
          <button className="text-button" type="button" onClick={renameConversation} disabled={!editable}>重命名</button>
          <button className="text-button" type="button" onClick={removeConversation}>删除</button>
        </div>
      </aside>

      <div className="vb-chat">
        <div className="vb-messages">
          {messages.length ? messages.map((item) => <div className={`vb-message vb-message--${item.role}`} key={item.id}>
            <div className="vb-message__avatar">{item.role === 'user' ? '我' : 'AI'}</div>
            <div className="vb-message__body">
              {item.role === 'assistant'
                ? (item.content ? <MarkdownView content={item.content} /> : <p className="muted">{item.status === 'STREAMING' ? '正在思考…' : '（没有内容）'}</p>)
                : <p>{item.content}</p>}
              {item.status === 'STREAMING' ? <span className="vb-cursor" /> : null}
              {item.status === 'FAILED' ? <p className="vb-message__error">{item.errorMessage || item.errorCode || 'AI 回复失败'}</p> : null}
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
          <button className="primary-canvas-button" type="submit" disabled={!editable || streaming || !input.trim()}>{streaming ? '生成中…' : '发送'}</button>
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
          <div className="row-actions">
            <button className="secondary-button" type="button" onClick={runPreview}>运行 / 刷新预览</button>
            <button className="secondary-button" type="button" disabled={runBusy || sandbox?.available === false}
              title={sandbox?.available === false ? (sandbox.reason || '服务端沙箱不可用') : '在服务器隔离沙箱里运行入口 JS 文件'}
              onClick={runOnServer}>{runBusy ? '运行中…' : '服务端运行'}</button>
          </div>
        </div>
        <iframe key={previewKey} className="vb-preview" title="预览" sandbox="allow-scripts" srcDoc={previewDocument} />
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
