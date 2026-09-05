import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { ApiError, AppShell, clearSession, createApiClient, Empty, ErrorState, formatCredits, formatDate, Loading, LoginPanel, MetricCard, Notice, PageHeader, Panel, readSession, Status, writeSession } from '@platform/shared';
import '@platform/shared/styles.css';

const APP_BASENAME = (import.meta.env?.VITE_APP_BASE || '/org').replace(/\/$/, '');

const navigation = [{ to: '/dashboard', icon: '◈', label: '机构总览' }, { to: '/tasks', icon: '✓', label: '课堂任务' }, { to: '/classes', icon: '▦', label: '班级与课堂' }, { to: '/members', icon: '♙', label: '成员管理' }, { to: '/works', icon: '✧', label: '作品点评' }, { to: '/inbox', icon: '✉', label: '站内信' }, { to: '/courses', icon: '◇', label: '课程中心' }, { to: '/work-data', icon: '▥', label: '作品数据中心', adminOnly: true }, { to: '/packages', icon: '◇', label: '积分套餐', adminOnly: true }, { to: '/enrollment', icon: '♙', label: '学员开通', adminOnly: true }, { to: '/account-requests', icon: '◉', label: '账号申请', adminOnly: true }, { to: '/materials', icon: '▤', label: '宣传物料' }, { to: '/help-feedback', icon: '◎', label: '问题反馈', adminOnly: true }];
const demos = [{ label: '机构管理员', login: 'org-admin', password: 'org123' }, { label: '授课教师', login: 'teacher-1', password: 'teach123' }];

function useData(load, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const refresh = async () => { setState((old) => ({ ...old, loading: true, error: null })); try { setState({ loading: false, error: null, data: await load() }); } catch (error) { setState({ loading: false, error, data: null }); } };
  useEffect(() => { refresh(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, refresh };
}

function Dashboard({ api }) {
  const { loading, error, data, refresh } = useData(() => api.get('org/overview'), [api]);
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  const isAdmin = data.scope?.role === 'ORG_ADMIN';
  const alerts = data.alerts || [];
  const recentSessions = data.recentSessions || [];
  const pendingWorks = data.pendingWorkItems || [];
  const unreadMessages = data.unreadNotificationItems || [];
  return <>
    <PageHeader eyebrow={isAdmin ? '机构经营' : '教师教学'} title={data.org.name} description={data.scope?.description || '实时掌握班级开课、作品和机构积分余额。'} actions={<button className="secondary-button" onClick={refresh}>刷新看板</button>} />
    <div className="metrics">
      <MetricCard label="活跃班级" value={data.activeClasses} hint={`${data.activeSessions} 个课堂正在进行`} />
      <MetricCard label="覆盖学员" value={data.students} hint={isAdmin ? `${data.teachers} 位教师` : `${data.scope?.classCount || 0} 个负责/授权班级`} tone="teal" />
      <MetricCard label="待点评作品" value={data.pendingWorks} hint={`作品总数 ${data.works} · 可按明细复算`} tone="orange" />
      <MetricCard label={isAdmin ? '可用积分' : '近 7 日课堂消耗'} value={isAdmin ? formatCredits(data.creditBalance) : formatCredits(data.usage7)} hint={isAdmin ? `近 7 日消耗 ${formatCredits(data.usage7)}` : '仅统计本人负责/授权班级'} tone="pink" />
    </div>
    <Panel title="统计口径">
      <div className="row-actions"><Status value={data.org.status} /><span className="muted">{data.scope?.description}</span><span className="muted">活跃班级：{data.breakdown?.activeClasses ?? data.activeClasses}</span><span className="muted">活跃课堂：{data.breakdown?.activeSessions ?? data.activeSessions}</span></div>
      <p className="muted">合同到期：{formatDate(data.org.contractExpiresAt)}{isAdmin ? ` · 教师席位：${data.org.teacherUsedSeats} / ${data.org.teacherSeats}` : ' · 经营席位与积分余额仅机构管理员可见'}</p>
    </Panel>
    <div className="split">
      <Panel title={isAdmin ? '经营提醒' : '教学提醒'}>
        {alerts.length ? <div className="card-list">{alerts.map((alert) => <Notice key={alert.code} tone={alert.level || 'info'}><strong>{alert.title}</strong><div>{alert.message}</div>{alert.daysRemaining !== undefined && <small>剩余 {alert.daysRemaining} 天</small>}{alert.used !== undefined && <small>已用 {alert.used} / {alert.total}</small>}</Notice>)}</div> : <Empty title={isAdmin ? '暂无经营预警' : '暂无教学预警'} body={isAdmin ? '合同、教师席位和积分余额目前没有触发预警。' : '当前范围内没有需要优先处理的系统预警。'} />}
      </Panel>
      <Panel title={`未读消息摘要（${data.unreadNotifications || 0}）`}>
        {unreadMessages.length ? <div className="card-list">{unreadMessages.map((item) => <article className="item-card" key={item.id}><strong>{item.title}</strong><p>{item.body}</p><span className="muted">{item.senderName || '系统'} · {formatDate(item.publishAt || item.createdAt)}</span></article>)}</div> : <Empty title="暂无未读消息" body="新的平台公告或机构通知会显示在这里。" />}
      </Panel>
    </div>
    <Panel title="近期课堂">
      {recentSessions.length ? <div className="table-wrap"><table><thead><tr><th>班级</th><th>课时</th><th>状态</th><th>开始时间</th><th>结束时间</th></tr></thead><tbody>{recentSessions.map((item) => <tr key={item.id}><td>{item.className || '—'}</td><td>{item.lessonTitle || '未关联课时'}</td><td><Status value={item.status} /></td><td>{formatDate(item.startedAt)}</td><td>{formatDate(item.endedAt)}</td></tr>)}</tbody></table></div> : <Empty title="暂无课堂记录" body="开始课堂后，最近课堂会出现在这里。" />}
    </Panel>
    <Panel title={`待点评作品（${data.pendingWorks || 0}）`}>
      {pendingWorks.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>学生</th><th>班级 / 课时</th><th>提交时间</th><th>状态</th></tr></thead><tbody>{pendingWorks.map((item) => <tr key={item.id}><td><strong>{item.title}</strong></td><td>{item.studentName || '—'}</td><td>{item.className || '—'}<div className="muted">{item.courseLessonTitle || '—'}</div></td><td>{formatDate(item.submittedAt)}</td><td><Status value={item.status} /></td></tr>)}</tbody></table></div> : <Empty title="暂无待点评作品" body="当前统计范围内没有状态为 PENDING 的作品。" />}
    </Panel>
  </>;
}

function TeachingTasks({ api }) {
  const tasks = useData(() => api.get('org/teaching/tasks'), [api]);
  const classes = useData(() => api.get('org/classes'), [api]);
  const [form, setForm] = useState({ classId: '', title: '', description: '', dueAt: '' });
  const [selectedClassId, setSelectedClassId] = useState('');
  const progress = useData(() => selectedClassId ? api.get(`org/teaching/classes/${selectedClassId}/progress`) : Promise.resolve({ items: [] }), [api, selectedClassId]);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
  async function create(event) { event.preventDefault(); setBusy(true); setMessage(''); try { await api.post('org/teaching/tasks', form); setForm({ classId: '', title: '', description: '', dueAt: '' }); setMessage('任务已发布。'); tasks.refresh(); } catch (error) { setMessage(error.message); } finally { setBusy(false); } }
  async function toggle(item) { try { await api.patch(`org/teaching/tasks/${item.id}`, { status: item.status === 'CLOSED' ? 'PUBLISHED' : 'CLOSED' }); tasks.refresh(); } catch (error) { setMessage(error.message); } }
  return <><PageHeader eyebrow="课堂教学" title="课堂任务" description="发布任务、设置截止时间，并查看班级完成情况。" actions={<button className="secondary-button" onClick={tasks.refresh}>刷新</button>} />{message && <Notice tone="info">{message}</Notice>}<div className="split"><Panel title="发布新任务"><form onSubmit={create}><label>班级<select required value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value })}><option value="">请选择班级</option>{(classes.data?.items || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>任务标题<input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label><label>任务说明<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label><label>截止时间<input type="datetime-local" value={form.dueAt ? form.dueAt.slice(0,16) : ''} onChange={(e) => setForm({ ...form, dueAt: e.target.value ? new Date(e.target.value).toISOString() : '' })} /></label><button className="primary-button" disabled={busy}>{busy ? '发布中…' : '发布任务'}</button></form></Panel><Panel title="任务列表">{tasks.loading ? <Loading /> : tasks.error ? <ErrorState error={tasks.error} onRetry={tasks.refresh} /> : tasks.data.items.length ? <div className="card-list">{tasks.data.items.map((item) => <article className="item-card" key={item.id}><div className="row-actions"><Status value={item.status} /><span className="muted">{item.className}</span></div><h3>{item.title}</h3><p>{item.description || '暂无说明'}</p><p className="muted">截止：{item.dueAt ? formatDate(item.dueAt) : '未设置'} · {item.lessonTitle || '未绑定课时'}</p><button className="text-button" onClick={() => toggle(item)}>{item.status === 'CLOSED' ? '重新发布' : '关闭任务'}</button></article>)}</div> : <Empty title="暂无课堂任务" body="发布第一个任务后会显示在这里。" />}</Panel></div><Panel title="班级学习进度"><label>选择班级<select value={selectedClassId} onChange={(e) => setSelectedClassId(e.target.value)}><option value="">请选择班级</option>{(classes.data?.items || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{selectedClassId && (progress.loading ? <Loading /> : progress.error ? <ErrorState error={progress.error} onRetry={progress.refresh} /> : progress.data.items.length ? <div className="table-wrap"><table><thead><tr><th>学生</th><th>完成课时</th><th>进度</th><th>最近学习</th></tr></thead><tbody>{progress.data.items.map((item) => <tr key={item.studentId}><td>{item.displayName}</td><td>{item.completedCount}/{item.assignedCount}</td><td>{item.completionRate}%</td><td>{formatDate(item.lastAccessedAt)}</td></tr>)}</tbody></table></div> : <Empty title="暂无学生进度" body="该班级还没有学习记录。" />)}</Panel></>;
}

function Classes({ api, user }) {
  const classes = useData(() => api.get('org/classes'), [api]);
  const courses = useData(() => api.get('org/course-series'), [api]);
  const teachers = useData(() => user.role === 'ORG_ADMIN' ? api.get('org/users?role=TEACHER') : Promise.resolve({ items: [] }), [api, user.role]);
  const students = useData(() => api.get('org/users?role=STUDENT'), [api]);
  const [curriculum, setCurriculum] = useState({ loading: false, error: null, byClass: {} });
  const [details, setDetails] = useState({});
  const [expanded, setExpanded] = useState('');
  const [selected, setSelected] = useState({});
  const [drafts, setDrafts] = useState({});
  const [newStudent, setNewStudent] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', defaultSeriesId: '', usageMode: 'CLASS_ONLY', teacherId: '' });

  useEffect(() => {
    let cancelled = false;
    const classItems = classes.data?.items;
    if (!classItems) return undefined;
    if (!classItems.length) { setCurriculum({ loading: false, error: null, byClass: {} }); return undefined; }
    setCurriculum((current) => ({ ...current, loading: true, error: null }));
    Promise.all(classItems.map(async (item) => [item.id, (await api.get(`org/classes/${item.id}/curriculum`)).items || []]))
      .then((entries) => { if (!cancelled) setCurriculum({ loading: false, error: null, byClass: Object.fromEntries(entries) }); })
      .catch((error) => { if (!cancelled) setCurriculum({ loading: false, error, byClass: {} }); });
    return () => { cancelled = true; };
  }, [api, classes.data]);

  const availableLessons = useMemo(() => (courses.data?.items || []).flatMap((course) => (course.lessons || []).map((lesson) => ({ ...lesson, seriesTitle: course.title, seriesId: course.id }))), [courses.data]);
  const teacherItems = teachers.data?.items || [];
  const studentItems = students.data?.items || [];

  async function loadDetail(classId, force = false) {
    if (!force && details[classId]) return details[classId];
    setBusy(true); setMessage('');
    try { const detail = await api.get(`org/classes/${classId}`); setDetails((current) => ({ ...current, [classId]: detail })); setDrafts((current) => ({ ...current, [classId]: (detail.curriculum || []).map((item) => item.lessonId) })); return detail; }
    catch (error) { setMessage(error.message); return null; } finally { setBusy(false); }
  }
  async function toggleDetail(classId) { if (expanded === classId) return setExpanded(''); await loadDetail(classId); setExpanded(classId); }
  async function start(classId, makeup = false) {
    const lessons = curriculum.byClass[classId] || [];
    const lessonId = selected[classId];
    if (!lessons.length) return setMessage('该班级尚未配置课单，无法开始课堂。');
    if (!lessonId) return setMessage('请先选择本班课单中的课时。');
    try { await api.post(`org/classes/${classId}/sessions/${makeup ? 'makeup' : 'start'}`, { lessonId, sessionKind: makeup ? 'MAKEUP' : 'REGULAR', capabilities: { allowImage: true, allowMusic: true } }); setMessage(makeup ? '补课课堂已开始。' : '课堂已开始。'); await classes.refresh(); await loadDetail(classId, true); }
    catch (error) { setMessage(error.message); }
  }
  async function end(classId, sessionId, cancel = false) {
    try { await api.post(`org/classes/${classId}/sessions/${sessionId}/${cancel ? 'cancel' : 'end'}`, { reason: cancel ? 'CANCELED' : 'MANUAL' }); setMessage(cancel ? '课堂已取消。' : '课堂已结束。'); await classes.refresh(); await loadDetail(classId, true); }
    catch (error) { setMessage(error.message); }
  }
  async function updateControls(classId, session, patch) {
    try {
      await api.put(`org/classes/${classId}/sessions/${session.id}/ai-controls`, { ...patch, capabilities: { ...session.capabilities, ...(patch.capabilities || {}) } });
      setMessage('课堂 AI 控制已更新。'); await loadDetail(classId, true);
    } catch (error) { setMessage(error.message); }
  }
  async function setSessionLimit(classId, session, field, label) {
    const current = field === 'sessionCreditCap' ? session.sessionCreditCap : session.studentCallCap;
    const value = window.prompt(`${label}（留空表示不限制）`, current == null ? '' : String(current));
    if (value === null) return;
    const normalized = value.trim() === '' ? null : Number(value);
    if (normalized !== null && (!Number.isInteger(normalized) || normalized < 1)) return setMessage(`${label}必须是正整数或留空。`);
    await updateControls(classId, session, { [field]: normalized });
  }
  async function create(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try { await api.post('org/classes', { ...form, defaultSeriesId: form.defaultSeriesId || null, teacherId: user.role === 'ORG_ADMIN' ? (form.teacherId || null) : undefined }); setForm({ name: '', defaultSeriesId: '', usageMode: 'CLASS_ONLY', teacherId: '' }); setMessage('班级已创建。请继续配置该班级课单后再开课。'); await classes.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  function setDraft(classId, lessonIds) { setDrafts((current) => ({ ...current, [classId]: lessonIds })); }
  function moveDraft(classId, index, offset) {
    const current = [...(drafts[classId] || [])]; const target = index + offset;
    if (target < 0 || target >= current.length) return;
    [current[index], current[target]] = [current[target], current[index]]; setDraft(classId, current);
  }
  async function saveCurriculum(classId) {
    try { await api.put(`org/classes/${classId}/curriculum`, { lessonIds: drafts[classId] || [] }); setMessage('课程计划和课时排序已保存。'); await classes.refresh(); await loadDetail(classId, true); }
    catch (error) { setMessage(error.message); }
  }
  async function addStudent(classId) {
    if (!newStudent[classId]) return setMessage('请先选择要加入的学员。');
    try { await api.post(`org/classes/${classId}/members/${newStudent[classId]}`, {}); setMessage('学员已加入班级。'); setNewStudent((current) => ({ ...current, [classId]: '' })); await loadDetail(classId, true); await classes.refresh(); }
    catch (error) { setMessage(error.message); }
  }
  async function removeStudent(classId, studentId) {
    try { await api.delete(`org/classes/${classId}/members/${studentId}`); setMessage('学员已移出班级。'); await loadDetail(classId, true); await classes.refresh(); }
    catch (error) { setMessage(error.message); }
  }
  async function assignTeacher(classId, teacherId) {
    try { await api.put(`org/classes/${classId}`, { teacherId: teacherId || null }); setMessage('负责教师已更新。'); await classes.refresh(); await loadDetail(classId, true); }
    catch (error) { setMessage(error.message); }
  }

  const refresh = () => { classes.refresh(); courses.refresh(); teachers.refresh(); students.refresh(); };
  const isSuccess = /已(开始|结束|取消|创建|保存|加入|移出|更新)/.test(message);
  return <>
    <PageHeader eyebrow="教学管理" title="班级与课堂" description="管理班级成员、课程计划、课时排序和课堂生命周期；所有数据均来自当前机构真实业务接口。" actions={<button className="secondary-button" onClick={refresh}>刷新</button>} />
    <div className="split">
      <Panel title="新建班级">
        <form onSubmit={create}>
          <label>班级名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></label>
          {user.role === 'ORG_ADMIN' && <label>负责教师<select value={form.teacherId} onChange={(event) => setForm({ ...form, teacherId: event.target.value })}><option value="">暂不指定</option>{teacherItems.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.displayName}（{teacher.login}）</option>)}</select></label>}
          <label>默认课包<select value={form.defaultSeriesId} onChange={(event) => setForm({ ...form, defaultSeriesId: event.target.value })}><option value="">稍后配置</option>{courses.data?.items?.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label>
          <label>使用模式<select value={form.usageMode} onChange={(event) => setForm({ ...form, usageMode: event.target.value })}><option value="CLASS_ONLY">仅跟随课堂</option><option value="ALWAYS_AVAILABLE">始终可用</option></select></label>
          <button className="primary-button" disabled={busy}>创建班级</button>
        </form>
      </Panel>
      <Panel title="课堂规则">
        <Notice>教师负责创建班级、加入/移出本机构学生、配置本班课程计划和开展课堂；教师只能管理本人负责或获授权的班级，开课只能选择本班课单中已发布且机构可访问的课时。机构管理员可处理机构级账号和班级授权。</Notice>
        {message && <Notice tone={isSuccess ? 'success' : 'danger'}>{message}</Notice>}
      </Panel>
    </div>
    <Panel title="可管理班级" actions={<span className="muted">共 {classes.data?.items?.length || 0} 个</span>}>
      {classes.loading || courses.loading ? <Loading /> : classes.error ? <ErrorState error={classes.error} onRetry={refresh} /> : classes.data.items.length ? <div className="card-list">
        {curriculum.error && <Notice tone="danger">班级课单加载失败：{curriculum.error.message}</Notice>}
        {classes.data.items.map((item) => {
          const lessons = curriculum.byClass[item.id] || []; const detail = details[item.id]; const currentDraft = drafts[item.id] || lessons.map((lesson) => lesson.lessonId);
          const members = detail?.members || []; const classStudents = members.filter((member) => member.classRole === 'STUDENT');
          const usedStudentIds = new Set(classStudents.map((member) => member.id));
          const availableStudents = studentItems.filter((student) => !usedStudentIds.has(student.id) && student.status === 'ACTIVE');
          return <article className="item-card" key={item.id}>
            <div className="row-actions"><h3>{item.name}</h3><Status value={item.status} />{item.currentSessionId && <Status value="ACTIVE SESSION" />}<span className="muted">学员 {item.studentCount || 0}</span></div>
            <p>使用模式：{item.usageMode}　教师：{item.teacherName || (item.teacherId === user.id ? user.displayName : '未设置')}</p>
            <div className="row-actions">
              <button className="secondary-button" onClick={() => toggleDetail(item.id)}>{expanded === item.id ? '收起详情' : '班级详情 / 课程计划'}</button>
              {item.currentSessionId ? <><button className="primary-button" onClick={() => end(item.id, item.currentSessionId)}>结束课堂</button><button className="text-button" onClick={() => end(item.id, item.currentSessionId, true)}>取消课堂</button></> : curriculum.loading ? <span className="muted">正在加载本班课单…</span> : lessons.length ? <><select value={selected[item.id] || ''} onChange={(event) => setSelected({ ...selected, [item.id]: event.target.value })}><option value="">选择课时</option>{lessons.map((lesson) => <option key={lesson.lessonId} value={lesson.lessonId}>第 {lesson.sort} 课 · {lesson.title}</option>)}</select><button className="primary-button" onClick={() => start(item.id)}>开始课堂</button><button className="secondary-button" onClick={() => start(item.id, true)}>开始补课</button></> : <span className="muted">尚未配置课单，请先在详情中设置课程计划。</span>}
            </div>
            {expanded === item.id && <div className="stacked-panels">
              {!detail ? <Loading label="正在读取班级详情…" /> : <>
                <Panel title="班级成员" description="成员变更会立即影响学生可见的班级课程内容。">
                  {(user.role === 'ORG_ADMIN' || user.role === 'TEACHER') && <div className="row-actions"><select value={newStudent[item.id] || ''} onChange={(event) => setNewStudent({ ...newStudent, [item.id]: event.target.value })}><option value="">选择学员加入班级</option>{availableStudents.map((student) => <option key={student.id} value={student.id}>{student.displayName}（{student.login}）</option>)}</select><button className="secondary-button" onClick={() => addStudent(item.id)}>加入学员</button></div>}
                  {user.role === 'ORG_ADMIN' && <label>负责教师<select value={item.teacherId || ''} onChange={(event) => assignTeacher(item.id, event.target.value)}><option value="">暂不指定</option>{teacherItems.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.displayName}</option>)}</select></label>}
                  {members.length ? <div className="table-wrap"><table><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{members.map((member) => <tr key={member.id}><td>{member.displayName}<div className="muted">{member.login}</div></td><td>{member.classRole === 'TEACHER' ? '教师' : '学员'}</td><td><Status value={member.status} /></td><td>{member.classRole === 'STUDENT' && (user.role === 'ORG_ADMIN' || user.role === 'TEACHER') ? <button className="text-button" onClick={() => removeStudent(item.id, member.id)}>移出班级</button> : '—'}</td></tr>)}</tbody></table></div> : <Empty title="暂无班级成员" body="可从上方选择学员加入班级。" />}
                </Panel>
                <Panel title="课程计划与课时排序" description="保存时服务端会重新编号 sort，确保课时顺序连续且不可重复。">
                  {availableLessons.length ? <div className="card-list">{currentDraft.map((lessonId, index) => { const lesson = availableLessons.find((candidate) => candidate.id === lessonId) || lessons.find((candidate) => candidate.lessonId === lessonId); return lesson ? <article className="item-card" key={lessonId}><div className="row-actions"><strong>第 {index + 1} 课 · {lesson.title}</strong><span className="muted">{lesson.seriesTitle || '已配置课时'}</span><button className="text-button" onClick={() => moveDraft(item.id, index, -1)} disabled={index === 0}>上移</button><button className="text-button" onClick={() => moveDraft(item.id, index, 1)} disabled={index === currentDraft.length - 1}>下移</button><button className="text-button" onClick={() => setDraft(item.id, currentDraft.filter((value) => value !== lessonId))}>移除</button></div><p className="muted">{lesson.summary || '暂无课时说明'} · {lesson.durationMinutes || 0} 分钟</p></article> : null; })}</div> : <Empty title="暂无可用课时" body="请先由平台或机构配置已发布课程。" />}
                  <label>添加课时<select value="" onChange={(event) => { if (event.target.value && !currentDraft.includes(event.target.value)) setDraft(item.id, [...currentDraft, event.target.value]); }}><option value="">选择可加入本班的课时</option>{availableLessons.filter((lesson) => !currentDraft.includes(lesson.id)).map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.seriesTitle} · {lesson.title}</option>)}</select></label>
                  <button className="primary-button" onClick={() => saveCurriculum(item.id)}>保存课程计划</button>
                </Panel>
                <div className="split"><Panel title="课程进度"><div className="table-wrap"><table><thead><tr><th>课时</th><th>开始</th><th>提交</th><th>发布</th></tr></thead><tbody>{(detail.progress || []).map((progress) => <tr key={progress.lessonId}><td>{progress.sort}. {progress.title}</td><td>{progress.startedStudentCount}/{progress.studentCount}（{progress.startedPercent}%）</td><td>{progress.submittedStudentCount}/{progress.studentCount}（{progress.submittedPercent}%）</td><td>{progress.publishedStudentCount}/{progress.studentCount}（{progress.publishedPercent}%）</td></tr>)}</tbody></table></div>{!detail.progress?.length && <Empty title="还没有课程计划" />}</Panel>
                  <Panel title="课堂记录"><div className="card-list">{(detail.sessions || []).map((session) => <article className="item-card" key={session.id}><div className="row-actions"><strong>{session.lessonTitle || '未指定课时'}</strong><Status value={session.status === 'ACTIVE' ? 'ACTIVE SESSION' : session.endedReason === 'CANCELED' ? 'CANCELED' : 'ENDED'} /><span className="muted">{session.sessionKind === 'MAKEUP' ? '补课' : '常规'}</span></div><p className="muted">开始：{formatDate(session.startedAt)}{session.endedAt ? ` · 结束：${formatDate(session.endedAt)}` : ''}</p><p className="muted">{session.endedReason ? `结果：${session.endedReason}` : '课堂进行中'}</p>{session.status === 'ACTIVE' && <div className="top-gap"><div className="row-actions"><strong>课堂 AI 控制</strong><button className="secondary-button" onClick={() => updateControls(item.id, session, { aiPaused: !session.aiPaused })}>{session.aiPaused ? '恢复 AI' : '立即暂停 AI'}</button><button className="text-button" onClick={() => setSessionLimit(item.id, session, 'sessionCreditCap', '课堂积分上限')}>积分上限：{session.sessionCreditCap == null ? '不限' : session.sessionCreditCap}</button><button className="text-button" onClick={() => setSessionLimit(item.id, session, 'studentCallCap', '单学生调用次数')}>单学生次数：{session.studentCallCap == null ? '不限' : session.studentCallCap}</button></div><div className="row-actions top-gap">{[['allowText','文本'],['allowImage','图片'],['allowMusic','音乐'],['allowVideo','视频'],['allowPodcast','播客'],['allowDubbing','配音']].map(([key, label]) => <label className="checkbox-option" key={key}><input type="checkbox" checked={Boolean(session.capabilities?.[key])} onChange={(event) => updateControls(item.id, session, { capabilities: { [key]: event.target.checked } })} />{label}</label>)}</div><small className="muted">{session.aiPaused ? '当前课堂已暂停全部 AI 请求。' : '服务端会强制执行开关、课堂积分上限和单学生调用次数。'}</small></div>}</article>)}</div>{!detail.sessions?.length && <Empty title="暂无课堂记录" />}</Panel></div>
              </>}
            </div>}
          </article>;
        })}
      </div> : <Empty title="暂无可管理班级" body="请先创建班级，再配置学生和课程。" />}
    </Panel>
  </>;
}

function Members({ api, user }) {
  const isAdmin = user.role === 'ORG_ADMIN';
  const members = useData(() => api.get(user.role === 'TEACHER' ? 'org/users?role=STUDENT' : 'org/users'), [api, user.role]);
  const classes = useData(() => api.get('org/classes'), [api]);
  const [roleFilter, setRoleFilter] = useState('');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({ role: 'STUDENT', login: '', displayName: '', password: '', phone: '' });
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState(null);
  const [editing, setEditing] = useState('');
  const [editDraft, setEditDraft] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const items = members.data?.items || [];
  const classItems = classes.data?.items || [];

  function parseImport() {
    const lines = importText.trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) throw new Error('请先粘贴批量导入内容');
    const delimiter = lines[0].includes('\t') ? '\t' : ',';
    const headers = lines[0].split(delimiter).map((item) => item.trim());
    const required = ['login', 'displayName', 'role', 'password'];
    if (required.some((key) => !headers.includes(key))) throw new Error('首行必须包含 login、displayName、role、password 列');
    return lines.slice(1).map((line) => {
      const values = line.split(delimiter).map((item) => item.trim());
      const item = Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
      item.classIds = String(item.classIds || '').split('|').map((value) => value.trim()).filter(Boolean);
      if (item.monthlyCreditAllowance) item.monthlyCreditAllowance = Number(item.monthlyCreditAllowance);
      return item;
    });
  }
  async function create(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try { await api.post('org/users', form); setForm({ role: 'STUDENT', login: '', displayName: '', password: '', phone: '' }); setMessage('账号已创建'); await members.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  function startEdit(item) {
    setEditing(item.id); setEditDraft({ id: item.id, displayName: item.displayName, phone: item.phone || '', status: item.status, permissions: item.permissions || [] });
  }
  async function saveEdit(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try { await api.put(`org/users/${editDraft.id}`, editDraft); setEditing(''); setEditDraft(null); setMessage('成员信息已保存'); await members.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  async function setStatus(item, status) {
    setBusy(true); setMessage('');
    try { await api.put(`org/users/${item.id}`, { status }); setMessage(status === 'ACTIVE' ? '账号已启用' : '账号已停用，已有会话已失效'); await members.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  async function resetPassword(item) {
    const password = window.prompt(`为 ${item.displayName} 设置新密码（至少 6 位）`);
    if (password === null) return;
    setBusy(true); setMessage('');
    try { await api.put(`org/users/${item.id}/password`, { password }); setMessage('密码已重置，原有登录会话已失效'); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  async function saveClasses(item, classIds) {
    setBusy(true); setMessage('');
    try { await api.put(`org/users/${item.id}/classes`, { classIds }); setMessage('班级归属已更新'); await members.refresh(); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  async function previewImport() {
    setBusy(true); setMessage('');
    try { const preview = await api.post('org/users/import/preview', { items: parseImport() }); setImportPreview(preview); setMessage(`预览完成：${preview.validCount} 条可导入，${preview.invalidCount} 条失败`); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }
  async function commitImport() {
    setBusy(true); setMessage('');
    try { const result = await api.post('org/users/import/commit', { items: parseImport() }); setImportPreview(null); setImportText(''); setMessage(`批量导入完成：${result.total} 个账号已创建`); await members.refresh(); }
    catch (error) { setMessage(error.message + (error.details?.items ? `（${error.details.invalidCount} 条失败，已全部回滚）` : '')); } finally { setBusy(false); }
  }
  const visibleItems = items.filter((item) => (!roleFilter || item.role === roleFilter) && (!search.trim() || [item.login, item.displayName, item.phone].some((value) => String(value || '').toLowerCase().includes(search.trim().toLowerCase()))));
  if (members.loading || classes.loading) return <Loading />;
  if (members.error) return <ErrorState error={members.error} onRetry={members.refresh} />;
  if (classes.error && isAdmin) return <ErrorState error={classes.error} onRetry={classes.refresh} />;

  return <>
    <PageHeader eyebrow="机构成员" title="教师与学生" description={isAdmin ? '创建、编辑、停用账号，并维护教师授权班级与学员调班记录。' : '仅展示当前权限范围内的机构成员；成员写操作需要机构管理员权限。'} actions={<button className="secondary-button" onClick={members.refresh}>刷新</button>} />
    {message && <Notice tone={message.includes('失败') || message.includes('错误') || message.includes('无权') ? 'danger' : 'success'}>{message}</Notice>}
    {isAdmin && <div className="split">
      <Panel title="新建账号">
        <form onSubmit={create}>
          <label>角色<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}><option value="STUDENT">学生</option><option value="TEACHER">教师</option></select></label>
          <label>登录名<input value={form.login} required onChange={(event) => setForm({ ...form, login: event.target.value })} /></label>
          <label>姓名<input value={form.displayName} required onChange={(event) => setForm({ ...form, displayName: event.target.value })} /></label>
          <label>初始密码<input type="password" minLength="6" value={form.password} required onChange={(event) => setForm({ ...form, password: event.target.value })} /></label>
          <label>手机号（可选）<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
          <button className="primary-button" disabled={busy}>创建账号</button>
        </form>
      </Panel>
      <Panel title="批量导入">
        <p className="muted">粘贴 CSV 或 TSV。列名：<code>login,displayName,role,password,phone,classIds</code>；多个班级 ID 用竖线分隔。系统先预览，提交时整批原子写入，任何错误都会全部回滚。</p>
        <textarea value={importText} rows="7" placeholder={'login,displayName,role,password,phone,classIds\nstudent-02,小明,STUDENT,student123,13800000001,class_xxx'} onChange={(event) => setImportText(event.target.value)} />
        <div className="row-actions"><button className="secondary-button" type="button" disabled={busy} onClick={previewImport}>预览导入</button>{importPreview?.invalidCount === 0 && <button className="primary-button" type="button" disabled={busy} onClick={commitImport}>确认整批导入</button>}</div>
        {importPreview && <div className="card-list"><Notice tone={importPreview.invalidCount ? 'danger' : 'success'}>共 {importPreview.total} 条，可导入 {importPreview.validCount} 条，失败 {importPreview.invalidCount} 条。</Notice>{importPreview.items.filter((item) => !item.valid).map((item) => <p className="muted" key={item.index}>第 {item.index} 行：{item.errors.join('；')}</p>)}</div>}
      </Panel>
    </div>}
    <Panel title="成员列表">
      <div className="row-actions"><input placeholder="搜索姓名、登录名或手机号" value={search} onChange={(event) => setSearch(event.target.value)} /><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="">全部角色</option><option value="TEACHER">教师</option><option value="STUDENT">学生</option></select></div>
      {visibleItems.length ? <div className="table-wrap"><table><thead><tr><th>姓名</th><th>角色</th><th>登录名</th><th>班级</th><th>额度</th><th>状态</th><th>操作</th></tr></thead><tbody>{visibleItems.map((item) => {
        const draft = editing === item.id ? editDraft : null;
        const assignedIds = (item.classes || []).filter((entry) => entry.role === item.role).map((entry) => entry.id);
        return <tr key={item.id}>
          <td>{draft ? <input value={draft.displayName} onChange={(event) => setEditDraft({ ...draft, displayName: event.target.value })} /> : item.displayName}</td>
          <td>{item.role}</td><td>{item.login}</td><td>{item.classes?.map((entry) => entry.name).join('、') || '未分配'}</td>
          <td>{item.role === 'STUDENT' ? formatCredits(item.creditsRemaining) : '—'}</td>
          <td>{draft ? <select value={draft.status} onChange={(event) => setEditDraft({ ...draft, status: event.target.value })}><option value="ACTIVE">ACTIVE</option><option value="DISABLED">DISABLED</option></select> : <Status value={item.status} />}</td>
          <td><div className="row-actions">{isAdmin && <>{draft ? <><button className="text-button" disabled={busy} onClick={saveEdit}>保存</button><button className="text-button" onClick={() => { setEditing(''); setEditDraft(null); }}>取消</button></> : <button className="text-button" onClick={() => startEdit(item)}>编辑</button>}<button className="text-button" disabled={busy} onClick={() => setStatus(item, item.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')}>{item.status === 'ACTIVE' ? '停用' : '启用'}</button><button className="text-button" disabled={busy} onClick={() => resetPassword(item)}>重置密码</button>{item.role === 'TEACHER' && <label className="muted">授权班级<select multiple value={assignedIds} onChange={(event) => saveClasses(item, [...event.target.selectedOptions].map((option) => option.value))}>{classItems.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>}{item.role === 'STUDENT' && <label className="muted">调班<select multiple value={assignedIds} onChange={(event) => saveClasses(item, [...event.target.selectedOptions].map((option) => option.value))}>{classItems.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>}</>}</div></td>
        </tr>;
      })}</tbody></table></div> : <Empty title="暂无成员" body="请先创建账号或调整搜索条件。" />}
    </Panel>
  </>;
}
function nodeLabel(snapshot, nodeId) {
  const node = snapshot?.nodes?.find((item) => item.id === nodeId);
  if (!node) return '整体作品';
  const data = node.data || {};
  return data.name || data.place || data.caption || data.text || data.title || nodeId;
}

function Works({ api }) {
  const [filters, setFilters] = useState({ search: '', status: '', classId: '' });
  const query = useMemo(() => { const value = new URLSearchParams(); if (filters.search.trim()) value.set('search', filters.search.trim()); if (filters.status) value.set('status', filters.status); if (filters.classId) value.set('classId', filters.classId); return '?' + value.toString() + '&includeSnapshot=true'; }, [filters]);
  const { loading, error, data, refresh } = useData(() => api.get('org/works' + query), [api, query]);
  const reports = useData(() => api.get('org/work-reports?status=PENDING'), [api]);
  const publishRequests = useData(() => api.get('org/work-publish-requests?status=PENDING'), [api]);
  const [publishAction, setPublishAction] = useState(null);
  const [publishForm, setPublishForm] = useState({ status: 'APPROVED', resolution: '' });
  const [publishBusy, setPublishBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reportAction, setReportAction] = useState(null);
  const [reportForm, setReportForm] = useState({ status: 'RESOLVED', actionTaken: 'NONE', resolution: '' });
  const [reportBusy, setReportBusy] = useState(false);
  const [selectedWork, setSelectedWork] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [teacherComment, setTeacherComment] = useState('');
  const [annotationContent, setAnnotationContent] = useState('');
  const [annotationNodeId, setAnnotationNodeId] = useState('');
  const [featureAction, setFeatureAction] = useState(null);
  const [featureForm, setFeatureForm] = useState({ featured: true, reason: '' });
  const [featureBusy, setFeatureBusy] = useState(false);

  async function openWork(work) {
    setSelectedWork(work);
    setTeacherComment(work.teacherComment || '');
    setAnnotationContent('');
    setAnnotationNodeId('');
    setAnnotationsLoading(true);
    try { setAnnotations((await api.get(`org/works/${work.id}/annotations`)).items || []); }
    catch (err) { setMessage(err.message); setAnnotations([]); }
    finally { setAnnotationsLoading(false); }
  }

  async function review(work, status, comment = work.teacherComment || '') {
    try {
      await api.put(`org/works/${work.id}/review`, { status, teacherComment: comment });
      setMessage(status === 'PUBLISHED' ? '作品已发布到机构作品墙。' : '作品审核状态已更新。');
      refresh();
      if (selectedWork?.id === work.id) setSelectedWork({ ...work, status, teacherComment: comment });
    } catch (err) { setMessage(err.message); }
  }

  async function handlePublishRequest() {
    if (!publishAction) return;
    setPublishBusy(true); setMessage('');
    try {
      await api.put(`org/work-publish-requests/${publishAction.id}`, publishForm);
      setMessage(`《${publishAction.workTitle}》的发布申请已处理。`);
      setPublishAction(null); setPublishForm({ status: 'APPROVED', resolution: '' }); publishRequests.refresh(); refresh();
    } catch (err) { setMessage(err.message); } finally { setPublishBusy(false); }
  }

  async function handleReport() {
    if (!reportAction) return;
    setReportBusy(true); setMessage('');
    try {
      await api.put(`org/work-reports/${reportAction.id}`, reportForm);
      setMessage(`举报《${reportAction.workTitle}》已处理。`);
      setReportAction(null); setReportForm({ status: 'RESOLVED', actionTaken: 'NONE', resolution: '' }); reports.refresh(); refresh();
    } catch (err) { setMessage(err.message); } finally { setReportBusy(false); }
  }

  async function handleFeature() {
    if (!featureAction) return;
    setFeatureBusy(true); setMessage('');
    try {
      await api.put(`org/works/${featureAction.id}/feature`, featureForm);
      setMessage(featureForm.featured ? `《${featureAction.title}》已设为机构精选。` : `《${featureAction.title}》已取消机构精选。`);
      setFeatureAction(null); setFeatureForm({ featured: true, reason: '' }); refresh();
    } catch (err) { setMessage(err.message); } finally { setFeatureBusy(false); }
  }

  async function addAnnotation(event) {
    event.preventDefault();
    if (!selectedWork) return;
    try {
      const item = await api.post(`org/works/${selectedWork.id}/annotations`, { content: annotationContent, nodeId: annotationNodeId || null });
      setAnnotations((items) => [item, ...items]);
      setAnnotationContent(''); setAnnotationNodeId(''); setMessage('画布点评已发送给学生。');
    } catch (err) { setMessage(err.message); }
  }

  async function toggleResolved(annotation) {
    if (!selectedWork) return;
    try {
      const updated = await api.put(`org/works/${selectedWork.id}/annotations/${annotation.id}`, { resolved: !annotation.resolvedAt });
      setAnnotations((items) => items.map((item) => item.id === updated.id ? updated : item));
    } catch (err) { setMessage(err.message); }
  }

  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  return <>
    <PageHeader eyebrow="学习成果" title="作品点评" description="审核作品、写整体或指定画布卡片的反馈，并将优秀作品发布到机构作品墙。" />
    {message && <Notice tone={message.includes('已') || message.includes('发送') ? 'success' : 'danger'}>{message}</Notice>}
    <Panel title="作品列表" actions={<button className="secondary-button" onClick={() => { refresh(); reports.refresh(); publishRequests.refresh(); }}>刷新</button>}><div className="form-grid"><label>关键词<input value={filters.search} placeholder="作品、学生或课时" onChange={(event) => setFilters({ ...filters, search: event.target.value })} /></label><label>状态<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">全部状态</option><option value="PENDING">待审核</option><option value="APPROVED">已通过</option><option value="PUBLISHED">已发布</option><option value="REJECTED">已驳回</option></select></label><label>班级<select value={filters.classId} onChange={(event) => setFilters({ ...filters, classId: event.target.value })}><option value="">全部班级</option>{[...new Map(data.items.filter((item) => item.classId).map((item) => [item.classId, item])).values()].map((item) => <option key={item.classId} value={item.classId}>{item.className || item.classId}</option>)}</select></label></div>
      {data.items.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>学生</th><th>提交时间</th><th>状态与授权</th><th>举报</th><th>操作</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><div className="muted">{item.description || '暂无说明'} · {item.className || '—'} / {item.courseLessonTitle || '—'}</div></td><td>{item.studentName}</td><td>{formatDate(item.submittedAt)}</td><td><Status value={item.status} /><div className="muted">{item.copyrightConfirmedAt ? '已确认机构内展示授权' : '未确认展示授权'}</div></td><td>{item.pendingReportCount ? <span className="status danger">待处理 {item.pendingReportCount}</span> : '—'}</td><td><div className="row-actions"><button className="text-button" onClick={() => openWork(item)}>查看与点评</button>{item.status === 'PENDING' && <button className="text-button" onClick={() => review(item, 'APPROVED')}>通过</button>}{item.status === 'APPROVED' && <button className="text-button" onClick={() => review(item, 'PUBLISHED')}>发布</button>}{item.status === 'PUBLISHED' && <button className="text-button" onClick={() => review(item, 'REJECTED', '机构下架')}>下架</button>}{item.status === 'PUBLISHED' && <button className="text-button" onClick={() => { setFeatureAction(item); setFeatureForm({ featured: !item.featured, reason: item.featuredReason || '' }); }}>{item.featured ? '取消精选' : '设为精选'}</button>}</div></td></tr>)}</tbody></table></div> : <Empty title="尚未收到作品" />}
    </Panel>
    <Panel title={`待处理发布申请 · ${publishRequests.data?.pending || 0} 条`}>{publishRequests.loading ? <Loading /> : publishRequests.error ? <ErrorState error={publishRequests.error} onRetry={publishRequests.refresh} /> : publishRequests.data.items.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>学生</th><th>申请说明</th><th>轮次 / 时间</th><th>操作</th></tr></thead><tbody>{publishRequests.data.items.map((item) => <tr key={item.id}><td>{item.workTitle}<div className="muted"><Status value={item.workStatus} /></div></td><td>{item.studentName || '—'}</td><td>{item.reason || '未填写说明'}</td><td>第 {item.round} 轮<div className="muted">{formatDate(item.requestedAt)}</div></td><td><button className="text-button" onClick={() => { setPublishAction(item); setPublishForm({ status: 'APPROVED', resolution: '' }); }}>处理</button></td></tr>)}</tbody></table></div> : <Empty title="暂无待处理发布申请" body="学生通过审核后可以主动申请发布作品。" />}</Panel>
    {featureAction && <Panel title={`机构精选 · ${featureAction.title}`}><Notice tone="info">精选作品会在机构作品墙优先展示；取消精选不会下架作品。</Notice><div className="form-grid"><label>精选状态<select value={featureForm.featured ? 'true' : 'false'} onChange={(event) => setFeatureForm({ ...featureForm, featured: event.target.value === 'true' })}><option value="true">设为机构精选</option><option value="false">取消机构精选</option></select></label></div>{featureForm.featured && <label>精选理由（可选）<input value={featureForm.reason} maxLength={500} placeholder="例如：故事结构完整，画面表达清晰。" onChange={(event) => setFeatureForm({ ...featureForm, reason: event.target.value })} /></label>}<div className="row-actions top-gap"><button className="primary-button" disabled={featureBusy} onClick={handleFeature}>{featureBusy ? '处理中…' : '确认精选设置'}</button><button className="secondary-button" disabled={featureBusy} onClick={() => setFeatureAction(null)}>取消</button></div></Panel>}
    {publishAction && <Panel title={`处理发布申请 · ${publishAction.workTitle}`}><div className="form-grid"><label>处理结果<select value={publishForm.status} onChange={(event) => setPublishForm({ ...publishForm, status: event.target.value })}><option value="APPROVED">批准并发布</option><option value="REJECTED">暂不发布</option></select></label></div><label>处理说明<textarea value={publishForm.resolution} maxLength={2000} placeholder="说明发布或暂缓的原因，学生会在我的作品页看到结果。" onChange={(event) => setPublishForm({ ...publishForm, resolution: event.target.value })} /></label><div className="row-actions top-gap"><button className="primary-button" disabled={publishBusy} onClick={handlePublishRequest}>{publishBusy ? '处理中…' : '确认处理'}</button><button className="secondary-button" disabled={publishBusy} onClick={() => setPublishAction(null)}>取消</button></div></Panel>}
    <Panel title={`待处理举报 · ${reports.data?.pending || 0} 条`}>{reports.loading ? <Loading /> : reports.error ? <ErrorState error={reports.error} onRetry={reports.refresh} /> : reports.data.items.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>举报人</th><th>类型 / 说明</th><th>时间</th><th>操作</th></tr></thead><tbody>{reports.data.items.map((item) => <tr key={item.id}><td>{item.workTitle}<div className="muted"><Status value={item.workStatus} /></div></td><td>{item.reporterName || '学生'}</td><td>{item.category}<div className="muted">{item.details || '未补充说明'}</div></td><td>{formatDate(item.createdAt)}</td><td><button className="text-button" onClick={() => { setReportAction(item); setReportForm({ status: 'RESOLVED', actionTaken: 'NONE', resolution: '' }); }}>处理</button></td></tr>)}</tbody></table></div> : <Empty title="暂无待处理举报" />}</Panel>
    {reportAction && <Panel title={`处理举报 · ${reportAction.workTitle}`}><div className="form-grid"><label>处理结果<select value={reportForm.status} onChange={(event) => setReportForm({ ...reportForm, status: event.target.value })}><option value="RESOLVED">已处理</option><option value="DISMISSED">驳回举报</option></select></label><label>作品动作<select value={reportForm.actionTaken} onChange={(event) => setReportForm({ ...reportForm, actionTaken: event.target.value })}><option value="NONE">保留作品</option><option value="UNPUBLISH">下架作品</option></select></label></div><label>处理说明<textarea value={reportForm.resolution} required maxLength={2000} placeholder="说明处理结论；下架时该说明会作为学生可见的下架原因。" onChange={(event) => setReportForm({ ...reportForm, resolution: event.target.value })} /></label><div className="row-actions top-gap"><button className="primary-button" disabled={reportBusy || !reportForm.resolution.trim()} onClick={handleReport}>{reportBusy ? '处理中…' : '确认处理'}</button><button className="secondary-button" disabled={reportBusy} onClick={() => setReportAction(null)}>取消</button></div></Panel>}
    {selectedWork && <>
      <Panel title={`画布预览与整体点评 · ${selectedWork.title}`} actions={<button className="secondary-button" onClick={() => setSelectedWork(null)}>关闭预览</button>}>
        <div className="row-actions canvas-meta"><span className="muted">学生：{selectedWork.studentName}</span><span className="muted">提交时间：{formatDate(selectedWork.submittedAt)}</span><Status value={selectedWork.status} /></div>
        <label>整体点评<textarea value={teacherComment} maxLength={2000} placeholder="告诉学生作品做得好的地方，以及下一步可以怎样改进。" onChange={(event) => setTeacherComment(event.target.value)} /></label>
        <div className="row-actions">{selectedWork.status === 'PENDING' && <button className="secondary-button" onClick={() => review(selectedWork, 'APPROVED', teacherComment)}>保存点评并通过</button>}{selectedWork.status === 'APPROVED' && <button className="primary-button" onClick={() => review(selectedWork, 'PUBLISHED', teacherComment)}>保存点评并发布</button>}{selectedWork.status === 'PUBLISHED' && <button className="secondary-button" onClick={() => review(selectedWork, 'REJECTED', teacherComment || '机构下架')}>下架作品</button>}<span className="muted">{selectedWork.copyrightConfirmedAt ? '学生已确认机构内展示授权' : '学生未确认展示授权，不能发布'}</span></div>
        <CanvasEditor key={selectedWork.id} initialSnapshot={selectedWork.canvasSnapshot} readOnly />
      </Panel>
      <Panel title="画布卡片批注" description="选择某张卡片可发送针对性建议；不选卡片即为整张作品的补充点评。">
        <form onSubmit={addAnnotation}><label>关联卡片<select value={annotationNodeId} onChange={(event) => setAnnotationNodeId(event.target.value)}><option value="">整张作品（不关联卡片）</option>{(selectedWork.canvasSnapshot?.nodes || []).map((node) => <option key={node.id} value={node.id}>{nodeLabel(selectedWork.canvasSnapshot, node.id)}</option>)}</select></label><label>批注内容<textarea value={annotationContent} required maxLength={1000} placeholder="例如：这里可以补充角色为什么要这样做。" onChange={(event) => setAnnotationContent(event.target.value)} /></label><button className="primary-button">发送批注</button></form>
        {annotationsLoading ? <Loading label="正在读取点评…" /> : annotations.length ? <div className="card-list">{annotations.map((annotation) => <article className="item-card" key={annotation.id}><div className="row-actions"><strong>{annotation.nodeId ? `卡片：${nodeLabel(selectedWork.canvasSnapshot, annotation.nodeId)}` : '整体补充点评'}</strong><Status value={annotation.resolvedAt ? 'APPROVED' : 'PENDING'} /></div><p>{annotation.content}</p><p className="muted">{annotation.authorName} · {formatDate(annotation.createdAt)}{annotation.resolvedAt ? ` · 已于 ${formatDate(annotation.resolvedAt)} 完成` : ''}</p><button className="text-button" onClick={() => toggleResolved(annotation)}>{annotation.resolvedAt ? '标记为待跟进' : '标记为已完成'}</button></article>)}</div> : <Empty title="还没有画布批注" body="可以先在上方写一条具体建议。" />}
      </Panel>
    </>}
  </>;
}

function AccountRequests({ api }) {
  const [filters, setFilters] = useState({ status: 'PENDING', type: '' });
  const query = useMemo(() => { const value = new URLSearchParams(); if (filters.status) value.set('status', filters.status); if (filters.type) value.set('type', filters.type); return '?' + value.toString(); }, [filters]);
  const { loading, error, data, refresh } = useData(() => api.get('org/account-requests' + query), [api, query]);
  const [action, setAction] = useState(null);
  const [form, setForm] = useState({ status: 'APPROVED', resolution: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  async function handle() {
    if (!action) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.put(`org/account-requests/${action.id}`, form);
      setMessage(action.type === 'DELETION' && form.status === 'APPROVED'
        ? `已批准注销申请，${result.studentName || '该学生'} 的账号已停用，学习与审计记录按保留规则保存。`
        : `《${result.studentName || action.studentName || '账号申请'}》已处理。`);
      setAction(null); setForm({ status: 'APPROVED', resolution: '' }); refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function openDetail(item) {
    setDetail(item); setDetailLoading(true);
    try { setDetail(await api.get(`org/account-requests/${item.id}`)); }
    catch (err) { setMessage(err.message); setDetail(null); }
    finally { setDetailLoading(false); }
  }
  return <>
    <PageHeader eyebrow="成员合规" title="学生账号申请" description="处理学生提交的账号注销与数据导出申请；批准注销会停用账号、撤销登录并保留必要业务记录。" actions={<button className="secondary-button" onClick={refresh}>刷新</button>} />
    <Panel title="申请筛选"><div className="form-grid">
      <label>状态<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">全部状态</option><option value="PENDING">待处理</option><option value="APPROVED">已批准</option><option value="REJECTED">已拒绝</option><option value="CANCELLED">学生已撤销</option></select></label>
      <label>类型<select value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}><option value="">全部类型</option><option value="DELETION">注销账号</option><option value="DATA_EXPORT">数据导出</option></select></label>
    </div></Panel>
    <Panel title={`申请记录 · ${data?.pending ?? 0} 条待处理`}>{loading ? <Loading /> : error ? <ErrorState error={error} onRetry={refresh} /> : data?.items?.length ? <div className="table-wrap"><table><thead><tr><th>学生</th><th>类型 / 原因</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><strong>{item.studentName || item.studentLogin || item.userId}</strong><div className="muted">{item.studentLogin || '—'}</div></td><td>{item.type === 'DELETION' ? '注销账号' : '数据导出'}<div className="muted">{item.reason || '未填写原因'}</div></td><td><Status value={item.status} /><div className="muted">{item.handlerName ? `处理人：${item.handlerName}` : '—'}</div></td><td>{formatDate(item.requestedAt)}</td><td><div className="row-actions">{item.status === 'PENDING' && <button className="text-button" onClick={() => { setAction(item); setForm({ status: 'APPROVED', resolution: '' }); }}>处理</button>}{item.type === 'DATA_EXPORT' && item.status === 'APPROVED' && <button className="text-button" onClick={() => openDetail(item)}>查看导出数据</button>}</div></td></tr>)}</tbody></table></div> : <Empty title="暂无符合条件的账号申请" />}</Panel>
    {action && <Panel title={`处理申请 · ${action.studentName || action.studentLogin || action.userId}`}><div className="form-grid"><label>处理结果<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="APPROVED">批准</option><option value="REJECTED">拒绝</option></select></label></div><label>处理说明<textarea value={form.resolution} required maxLength={2000} placeholder={action.type === 'DELETION' ? '说明注销结论；批准后账号立即停用，业务记录按保留规则保存。' : '说明数据导出处理结论；批准后学生可在账号中心查看导出内容。'} onChange={(event) => setForm({ ...form, resolution: event.target.value })} /></label><div className="row-actions top-gap"><button className="primary-button" disabled={busy || !form.resolution.trim()} onClick={handle}>{busy ? '处理中…' : '确认处理'}</button><button className="secondary-button" disabled={busy} onClick={() => setAction(null)}>取消</button></div></Panel>}
    {detailLoading ? <Panel title="正在读取导出数据"><Loading /></Panel> : null}
    {detail && !detailLoading && <Panel title={`导出数据 · ${detail.studentName || detail.studentLogin || detail.userId}`} actions={<button className="secondary-button" onClick={() => setDetail(null)}>关闭</button>}><p className="muted">以下为当前数据库生成的学生数据概览，不包含密码、会话令牌或内部审计字段。</p><pre className="json-view">{JSON.stringify(detail.exportPayload, null, 2)}</pre></Panel>}
    {message && <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice>}
  </>;
}

const HELP_FEEDBACK_CATEGORY_LABELS = { ACCOUNT: '账号', CANVAS: '画布创作', AI: 'AI 能力', COURSE: '课程学习', CLIENT: '客户端', DATA: '数据与隐私', OTHER: '其他' };
const HELP_FEEDBACK_STATUS_LABELS = { SUBMITTED: '已提交', IN_PROGRESS: '处理中', RESOLVED: '已解决', CLOSED: '已关闭' };

function HelpFeedbackPage({ api }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') || '';
  const category = searchParams.get('category') || '';
  const query = useMemo(() => { const value = new URLSearchParams(); if (status) value.set('status', status); if (category) value.set('category', category); return value.toString() ? '?' + value.toString() : ''; }, [status, category]);
  const { loading, error, data, refresh } = useData(() => api.get('org/help-feedback' + query), [api, query]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({ status: 'IN_PROGRESS', resolution: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  function updateFilter(key, value) { const next = new URLSearchParams(searchParams); if (value) next.set(key, value); else next.delete(key); setSearchParams(next, { replace: true }); }
  async function openDetail(item) {
    setSelected(item); setDetail(null); setMessage('');
    try { setDetail(await api.get(`org/help-feedback/${item.id}`)); setForm({ status: item.status === 'SUBMITTED' ? 'IN_PROGRESS' : 'RESOLVED', resolution: item.resolution || '' }); }
    catch (err) { setMessage(err.message); }
  }
  async function handleFeedback() {
    if (!selected) return; setBusy(true); setMessage('');
    try { await api.put(`org/help-feedback/${selected.id}`, form); setMessage('反馈处理结果已保存。'); setSelected(null); setDetail(null); refresh(); }
    catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  return <>
    <PageHeader eyebrow="学生服务" title="问题反馈处理" description="跟进学生在帮助中心提交的问题反馈，形成可追踪的处理记录。" actions={<button className="secondary-button" onClick={refresh}>刷新</button>} />
    <div className="metrics"><MetricCard label="待处理" value={data?.submitted ?? 0} hint="学生已提交，等待机构响应" tone="orange" /><MetricCard label="处理中" value={data?.inProgress ?? 0} hint="已有管理员跟进" /><MetricCard label="已解决 / 关闭" value={data?.resolved ?? 0} hint="含已关闭反馈" tone="teal" /></div>
    {message ? <Notice tone={message.includes('已保存') ? 'success' : 'danger'}>{message}</Notice> : null}
    <Panel title="筛选">
      <div className="form-grid">
        <label>状态<select value={status} onChange={(event) => updateFilter('status', event.target.value)}><option value="">全部状态</option>{Object.entries(HELP_FEEDBACK_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>分类<select value={category} onChange={(event) => updateFilter('category', event.target.value)}><option value="">全部分类</option>{Object.entries(HELP_FEEDBACK_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
    </Panel>
    <Panel title={`反馈列表 · 共 ${data?.total ?? 0} 条`}>
      {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={refresh} /> : data?.items?.length ? <div className="table-wrap"><table><thead><tr><th>学生</th><th>分类 / 标题</th><th>状态</th><th>提交时间</th><th>操作</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><strong>{item.userName || item.userLogin || item.userId}</strong><div className="muted">{item.userLogin || '—'}</div></td><td>{HELP_FEEDBACK_CATEGORY_LABELS[item.category] || item.category}<div><strong>{item.subject}</strong></div><div className="muted">{item.body}</div></td><td><Status value={HELP_FEEDBACK_STATUS_LABELS[item.status] || item.status} /><div className="muted">{item.handlerName ? `处理人：${item.handlerName}` : '—'}</div></td><td>{formatDate(item.submittedAt)}</td><td><button className="text-button" onClick={() => openDetail(item)}>查看处理</button></td></tr>)}</tbody></table></div> : <Empty title="暂无符合条件的学生反馈" body="学生可在“帮助与下载”页提交问题，机构管理员在这里处理。" />}
    </Panel>
    {selected && <Panel title={`处理反馈 · ${selected.subject}`} actions={<button className="secondary-button" onClick={() => { setSelected(null); setDetail(null); }}>关闭</button>}>
      {!detail ? <Loading label="正在读取反馈详情…" /> : <>
        <div className="row-actions"><Status value={HELP_FEEDBACK_CATEGORY_LABELS[detail.category] || detail.category} /><Status value={HELP_FEEDBACK_STATUS_LABELS[detail.status] || detail.status} /><span className="muted">{detail.userName || detail.userLogin} · {formatDate(detail.submittedAt)}</span></div>
        <Panel title="学生描述"><p>{detail.body}</p><p className="muted">{detail.contact ? `联系方式：${detail.contact}` : '学生未填写联系方式'}</p>{detail.resolution ? <p><strong>既有处理结果：</strong>{detail.resolution}</p> : null}</Panel>
        <label>处理状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}><option value="IN_PROGRESS">处理中</option><option value="RESOLVED">已解决</option><option value="CLOSED">已关闭</option></select></label>
        <label>处理结果<textarea value={form.resolution} required maxLength={2000} placeholder="写明排查结论、已采取的措施或需要学生补充的信息。" onChange={(event) => setForm({ ...form, resolution: event.target.value })} /></label>
        <div className="row-actions top-gap"><button className="primary-button" disabled={busy || !form.resolution.trim()} onClick={handleFeedback}>{busy ? '保存中…' : '保存处理结果'}</button></div>
      </>}
    </Panel>}
  </>;
}

function OrgCourses({ api }) {
  const detailMatch = (window.location.pathname || '').match(/\/courses\/([^/]+)$/);
  const seriesId = detailMatch ? detailMatch[1] : null;
  const { loading, error, data, refresh } = useData(() => api.get('org/course-series'), [api]);
  const detail = useData(() => seriesId ? api.get('org/course-series/' + encodeURIComponent(seriesId)) : Promise.resolve(null), [api, seriesId]);
  const [expanded, setExpanded] = useState('');
  if (seriesId) {
    if (detail.loading) return <Loading />;
    if (detail.error) return <ErrorState error={detail.error} onRetry={detail.refresh} />;
    const c = detail.data;
    if (!c) return <Empty title="课包不存在" body="该课包不存在或当前机构不可访问。" />;
    return <>
      <PageHeader eyebrow="教学资源" title={c.title} description={c.description || '查看课包详细资料与课时正文。'} actions={<button className="secondary-button" onClick={() => navigate('/courses')}>返回课程中心</button>} />
      <div className="metrics">
        <MetricCard label="难度" value={c.difficultyLevel ? `${c.difficultyLevel}/5` : '—'} hint="课程难度" />
        <MetricCard label="适学年龄" value={c.ageRangeMin || c.ageRangeMax ? `${c.ageRangeMin ?? '?'}-${c.ageRangeMax ?? '?'}岁` : '—'} hint="适学年龄范围" />
        <MetricCard label="课时数" value={c.lessonCount} hint={'共 ' + (c.lessons?.length || 0) + ' 节已发布'} tone="teal" />
        <MetricCard label="版本" value={c.version} hint={'归属 ' + (c.assignedToCurrentOrg ? '本机构' : '平台公开')} tone="orange" />
      </div>
      {Array.isArray(c.tags) && c.tags.length ? <div className="tag-list"><span className="muted">标签：</span>{c.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div> : null}
      <Panel title="课时列表">
        {c.lessons?.length ? <div className="table-wrap"><table><thead><tr><th>#</th><th>标题</th><th>时长</th><th>正文</th></tr></thead><tbody>{c.lessons.map((lesson) => <tr key={lesson.id}><td>{lesson.sort}</td><td><strong>{lesson.title}</strong><div className="muted">{lesson.summary}</div></td><td>{lesson.durationMinutes} 分钟</td><td><div style={{ whiteSpace: 'pre-wrap', maxWidth: 480 }}>{lesson.lessonContent || '—'}</div></td></tr>)}</tbody></table></div> : <Empty title="暂无课时" />}
      </Panel>
    </>;
  }
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  const sourceLabels = { PLATFORM: '平台课包', ORG: '机构自有' };
  const visibilityLabels = { ALL_ORGS: '全部机构可见', ASSIGNED_ORGS: '平台授权', PRIVATE: '私有' };
  return <>
    <PageHeader eyebrow="教学资源" title="课程中心" description="查看本机构已开通的平台课包、机构课包与课时安排。" actions={<button className="secondary-button" onClick={refresh}>刷新</button>} />
    <div className="metrics"><MetricCard label="可用课包" value={data.items.length} hint="仅统计当前已发布课程" /><MetricCard label="平台授权课包" value={data.items.filter((item) => item.ownerType === 'PLATFORM' && item.assignedToCurrentOrg).length} hint="平台单独授权后可见" tone="teal" /><MetricCard label="总课时" value={data.items.reduce((sum, item) => sum + item.lessonCount, 0)} hint="已发布课时" tone="orange" /></div>
    <Panel title="课程列表">
      {data.items.length ? <div className="card-list">{data.items.map((course) => <article className="item-card" key={course.id}>
        <div className="row-actions"><h3><button className="text-button" onClick={() => navigate('/courses/' + course.id)}>{course.title}</button></h3><Status value={course.status} /><span className="muted">{sourceLabels[course.ownerType] || course.ownerType}</span><span className="muted">{visibilityLabels[course.visibility] || course.visibility}</span><span className="muted">v{course.version}</span></div>
        <p>{course.description || '暂无课程说明'}</p>
        <p className="muted">{course.difficultyLevel ? `难度 ${course.difficultyLevel}/5 · ` : ''}{course.ageRangeMin || course.ageRangeMax ? `适学 ${course.ageRangeMin ?? '?'}-${course.ageRangeMax ?? '?'}岁 · ` : ''}{course.lessonCount} 节课时{course.ownerType === 'PLATFORM' && course.assignedToCurrentOrg ? ' · 平台已授权' : ''}</p>
        {Array.isArray(course.tags) && course.tags.length ? <div className="tag-list">{course.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div> : null}
        <div className="row-actions"><button className="text-button" onClick={() => setExpanded(expanded === course.id ? '' : course.id)}>{expanded === course.id ? '收起课时' : '查看课时'}</button><button className="text-button" onClick={() => navigate('/courses/' + course.id)}>查看详情</button><span className="muted">更新：{formatDate(course.updatedAt)}</span></div>
        {expanded === course.id && (course.lessons?.length ? <ol className="course-lessons">{course.lessons.map((lesson) => <li key={lesson.id}>{lesson.title} · {lesson.durationMinutes} 分钟{lesson.summary ? ' · ' + lesson.summary : ''}</li>)}</ol> : <Empty title="该课包暂无已发布课时" />)}
      </article>)}</div> : <Empty title="暂无可用课程" body="请让平台管理员授权课包，或先创建机构自有课程。" />}
    </Panel>
  </>;
}

const packageCapabilities = [
  ['allowImage', '生图'], ['allowMusic', '生音乐'], ['allowVideo', '生视频'],
  ['allowPodcast', '生播客'], ['allowDubbing', '配音'],
];

function packageFormFrom(item = {}) {
  return {
    name: item.name || '', priceFen: item.priceFen ?? 0, monthlyCredits: item.monthlyCredits ?? 100,
    bonusCredits: item.bonusCredits ?? 0, durationDays: item.durationDays ?? 30, studentSeats: item.studentSeats ?? 1,
    capabilities: Object.fromEntries(packageCapabilities.map(([key]) => [key, item.capabilities?.[key] || false])),
  };
}

function BillingPackages({ api, user }) {
  const { loading, error, data, refresh } = useData(() => api.get('org/billing/packages'), [api]);
  const isAdmin = user?.role === 'ORG_ADMIN';
  const [form, setForm] = useState(packageFormFrom());
  const [editingId, setEditingId] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  function setValue(key, value) { setForm((current) => ({ ...current, [key]: value })); }
  function setCapability(key, value) { setForm((current) => ({ ...current, capabilities: { ...current.capabilities, [key]: value } })); }
  async function submit(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try {
      const payload = { ...form, priceFen: Number(form.priceFen), monthlyCredits: Number(form.monthlyCredits), bonusCredits: Number(form.bonusCredits), durationDays: Number(form.durationDays), studentSeats: Number(form.studentSeats) };
      if (editingId) await api.put('org/billing/packages/' + editingId, payload);
      else await api.post('org/billing/packages', payload);
      setEditingId(''); setForm(packageFormFrom()); setMessage('套餐已保存。'); refresh();
    } catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  async function toggle(item) {
    try { await api.put('org/billing/packages/' + item.id, { status: item.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }); refresh(); }
    catch (err) { setMessage(err.message); }
  }
  return <>
    <PageHeader eyebrow="积分经营" title="积分套餐" description="维护学员套餐的月度积分、有效期与可使用 AI 能力。" actions={<button className="secondary-button" onClick={refresh}>刷新</button>} />
    {!isAdmin && <Notice tone="info">当前账号为教师，仅可查看套餐；套餐创建、编辑和启停由机构管理员操作。</Notice>}
    <div className="split">
      {isAdmin && <Panel title={editingId ? '编辑套餐' : '新建套餐'}>
        <form onSubmit={submit}>
          <label>套餐名称<input value={form.name} onChange={(e) => setValue('name', e.target.value)} required /></label>
          <div className="form-grid">
            <label>价格（分）<input type="number" min="0" value={form.priceFen} onChange={(e) => setValue('priceFen', e.target.value)} /></label>
            <label>月度积分<input type="number" min="0" value={form.monthlyCredits} onChange={(e) => setValue('monthlyCredits', e.target.value)} /></label>
            <label>赠送积分<input type="number" min="0" value={form.bonusCredits} onChange={(e) => setValue('bonusCredits', e.target.value)} /></label>
            <label>有效期（天）<input type="number" min="1" max="3650" value={form.durationDays} onChange={(e) => setValue('durationDays', e.target.value)} /></label><label>学员席位<input type="number" min="1" max="100000" value={form.studentSeats} onChange={(e) => setValue('studentSeats', e.target.value)} required /></label>
          </div>
          <label>AI 能力</label>
          <div className="row-actions">{packageCapabilities.map(([key, label]) => <label key={key} className="checkbox-option"><input type="checkbox" checked={form.capabilities[key]} onChange={(e) => setCapability(key, e.target.checked)} />{label}</label>)}</div>
          {message && <Notice tone={message === '套餐已保存。' ? 'success' : 'danger'}>{message}</Notice>}
          <div className="row-actions"><button className="primary-button" disabled={saving}>{saving ? '保存中…' : editingId ? '保存修改' : '创建套餐'}</button>{editingId && <button type="button" className="secondary-button" onClick={() => { setEditingId(''); setForm(packageFormFrom()); }}>取消编辑</button>}</div>
        </form>
      </Panel>}
      <Panel title="套餐列表">
        {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={refresh} /> : data.items.length ? <div className="table-wrap"><table><thead><tr><th>套餐</th><th>价格</th><th>积分</th><th>有效期</th><th>学员席位</th><th>AI 能力</th><th>状态</th>{isAdmin && <th>操作</th>}</tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>¥{(item.priceFen / 100).toFixed(2)}</td><td>{formatCredits(item.monthlyCredits)} / 月{item.bonusCredits ? <div className="muted">赠送 {formatCredits(item.bonusCredits)}</div> : null}</td><td>{item.durationDays} 天</td><td>{item.occupiedSeats} / {item.studentSeats}<div className="muted">可用 {item.availableSeats}</div></td><td>{packageCapabilities.filter(([key]) => item.capabilities[key]).map(([, label]) => label).join(' / ') || '未开放'}</td><td><Status value={item.status} /></td>{isAdmin && <td><div className="row-actions"><button className="text-button" onClick={() => { setEditingId(item.id); setForm(packageFormFrom(item)); setMessage(''); }}>编辑</button><button className="text-button" onClick={() => toggle(item)}>{item.status === 'ACTIVE' ? '停用' : '启用'}</button></div></td>}</tr>)}</tbody></table></div> : <Empty title="尚未配置套餐" />}
      </Panel>
    </div>
  </>;
}

function workDataCsvValue(value) {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}

function WorkDataTable({ title, items, labelKey, apiKey }) {
  const nameField = labelKey === '班级' ? 'className' : labelKey === '课时' ? 'lessonTitle' : 'studentName';
  return <Panel title={title}>
    {items.length ? <div className="table-wrap"><table><thead><tr><th>{labelKey}</th><th>活跃学员</th><th>活跃项目</th><th>完成项目</th><th>提交</th><th>发布</th><th>反馈</th><th>AI 调用 / 积分</th><th>最近活动</th></tr></thead><tbody>{items.map((item) => <tr key={item[apiKey]}><td><strong>{item[nameField] || '未关联'}</strong></td><td>{item.activeStudentCount}</td><td>{item.activeProjectCount}</td><td>{item.completedProjectCount}</td><td>{item.submittedWorkCount}</td><td>{item.publishedWorkCount}</td><td>{item.feedbackCount}</td><td>{item.aiCallCount} / {formatCredits(item.aiCredits)}</td><td>{formatDate(item.lastActivityAt)}</td></tr>)}</tbody></table></div> : <Empty title="当前筛选范围暂无可汇总的作品数据" />}
  </Panel>;
}

function WorkDataPage({ api, user }) {
  const [filters, setFilters] = useState({ days: '30', classId: '', lessonId: '', studentId: '' });
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState('');
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString(), [filters]);
  const report = useData(() => api.get('org/work-data?' + query), [api, query]);

  async function exportCsv() {
    setExporting(true); setMessage('');
    try {
      const data = await api.get('org/work-data/export?' + query);
      const header = (data.columns || []).map((column) => workDataCsvValue(column.label)).join(',');
      const lines = (data.items || []).map((item) => (data.columns || []).map((column) => workDataCsvValue(item[column.key])).join(','));
      const blob = new Blob(['\uFEFF' + [header, ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = data.fileName || '作品数据中心-脱敏导出.csv';
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
      setMessage(`已导出 ${lines.length} 行脱敏学员汇总，并已记录导出审计。`);
    } catch (error) { setMessage(error.message || '导出失败'); } finally { setExporting(false); }
  }

  if (user?.role !== 'ORG_ADMIN') return <><PageHeader eyebrow="机构运营" title="作品数据中心" description="作品数据与脱敏导出仅向机构管理员开放。" /><Panel title="权限说明"><Notice tone="info">授课教师可在班级、作品点评和积分用量中处理日常教学；为保护未成年人创作数据，本中心及其导出功能仅机构管理员可访问。</Notice></Panel></>;
  if (report.loading) return <Loading label="正在汇总作品数据…" />;
  if (report.error) return <ErrorState error={report.error} onRetry={report.refresh} />;
  const data = report.data; const summary = data.summary || {}; const selectors = data.filters || {}; const breakdowns = data.breakdowns || {};
  return <>
    <PageHeader eyebrow="机构运营" title="作品数据中心" description={`按班级、课程课时和学员下钻近 ${data.scope.days} 日真实创作数据；不包含访问量、访客或公开分享统计。`} actions={<div className="row-actions"><button className="secondary-button" onClick={report.refresh}>刷新</button><button className="primary-button" onClick={exportCsv} disabled={exporting}>{exporting ? '导出中…' : '导出脱敏汇总'}</button></div>} />
    <Notice tone="info">导出仅含“张同学”这类脱敏别名及汇总数字，不含学员 ID、登录名、手机号或完整姓名；每次导出都会写入审计记录。</Notice>
    {message ? <Notice tone={message.includes('失败') ? 'danger' : 'success'}>{message}</Notice> : null}
    <Panel title="统计范围">
      <div className="row-actions top-gap">{['7', '14', '30'].map((days) => <button type="button" key={days} className={filters.days === days ? 'primary-button' : 'secondary-button'} onClick={() => setFilters({ ...filters, days })}>近 {days} 日</button>)}</div>
      <div className="form-grid top-gap">
        <label>班级<select value={filters.classId} onChange={(e) => setFilters({ ...filters, classId: e.target.value })}><option value="">全部班级</option>{(selectors.classes || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>课程课时<select value={filters.lessonId} onChange={(e) => setFilters({ ...filters, lessonId: e.target.value })}><option value="">全部课时</option>{(selectors.lessons || []).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <label>学员<select value={filters.studentId} onChange={(e) => setFilters({ ...filters, studentId: e.target.value })}><option value="">全部学员</option>{(selectors.students || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      </div>
    </Panel>
    <div className="metrics"><MetricCard label="覆盖学员" value={summary.enrolledStudents || 0} hint="当前班级范围的在册学员" /><MetricCard label="活跃学员 / 项目" value={`${summary.activeStudents || 0} / ${summary.activeProjects || 0}`} hint="近周期有保存或状态更新" tone="teal" /><MetricCard label="完成 / 提交" value={`${summary.completedProjects || 0} / ${summary.submittedWorks || 0}`} hint="项目状态与作品提交" tone="orange" /><MetricCard label="发布 / 反馈" value={`${summary.publishedWorks || 0} / ${summary.feedbackCount || 0}`} hint="审核发布与教师新增反馈" tone="pink" /><MetricCard label="成功 AI / 积分" value={`${summary.aiCalls || 0} / ${formatCredits(summary.aiCredits)}`} hint="仅统计成功且关联项目的调用" tone="violet" /></div>
    <div className="split"><WorkDataTable title="按班级下钻" items={breakdowns.classes || []} labelKey="班级" apiKey="classId" /><WorkDataTable title="按课程课时下钻" items={breakdowns.lessons || []} labelKey="课时" apiKey="lessonId" /></div>
    <WorkDataTable title="按学员下钻" items={breakdowns.students || []} labelKey="学员" apiKey="studentId" />
    <Panel title="统计口径"><ul className="muted"><li>活跃：{data.definitions.active}</li><li>完成：{data.definitions.completed}</li><li>发布：{data.definitions.published}</li><li>反馈：{data.definitions.feedback}</li><li>AI：{data.definitions.ai}</li></ul></Panel>
  </>;
}
function EnrollmentPage({ api, user }) {
  const isAdmin = user?.role === 'ORG_ADMIN';
  const { loading, error, data, refresh } = useData(async () => {
    if (!isAdmin) return { packages: { items: [] }, students: { items: [] }, enrollments: { items: [], summary: {} } };
    const [packages, students, enrollments] = await Promise.all([api.get('org/billing/packages'), api.get('org/users?role=STUDENT'), api.get('org/billing/enrollments')]);
    return { packages, students, enrollments };
  }, [api, isAdmin]);
  const [form, setForm] = useState({ studentId: '', packageId: '', paymentStatus: 'UNRECORDED', notes: '' });
  const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const packages = data?.packages?.items || []; const students = data?.students?.items || []; const enrollmentData = data?.enrollments || { items: [], summary: {} };
  const activePackages = packages.filter((item) => item.status === 'ACTIVE' && item.availableSeats > 0);
  async function createEnrollment(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try { await api.post('org/billing/enrollments', form); setForm({ studentId: '', packageId: '', paymentStatus: 'UNRECORDED', notes: '' }); setMessage('已创建待开通单，请按线下履约情况登记并完成开通。'); await refresh(); }
    catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function act(item, action, payload = {}) {
    setBusy(true); setMessage('');
    try { await api.post(`org/billing/enrollments/${item.id}/${action}`, payload); setMessage(action === 'payment-record' ? '已登记线下收款状态。' : '开通单状态已更新。'); await refresh(); }
    catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  if (!isAdmin) return <><PageHeader eyebrow="积分经营" title="学员开通" description="学员套餐、席位与线下履约由机构管理员统一管理。" /><Notice tone="info">当前账号为教师，没有学员套餐开通与席位管理权限。</Notice></>;
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  const summary = enrollmentData.summary || {};
  return <>
    <PageHeader eyebrow="积分经营" title="学员开通" description="登记线下履约、分配套餐席位并管理生效、停用、续费和到期提醒。" actions={<button className="secondary-button" onClick={refresh}>刷新</button>} />
    <Notice tone="info">此页面只记录机构线下收款与履约状态；不接入在线支付、自动续费或收款回调。生效中的开通单占用套餐席位；停用、作废和到期后释放席位，并会停止该学员账号的登录与 AI 使用权限。</Notice>
    {message ? <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice> : null}
    <div className="metrics"><MetricCard label="待开通" value={summary.pending || 0} hint="尚未生效，不占席位" /><MetricCard label="生效中" value={summary.active || 0} hint="正在占用套餐席位" tone="teal" /><MetricCard label="已停用" value={summary.suspended || 0} hint="可恢复或续费" tone="orange" /><MetricCard label="30 日内到期" value={summary.expiringSoon || 0} hint="请及时安排续费" tone="pink" /></div>
    <div className="split">
      <Panel title="新建学员开通单"><form onSubmit={createEnrollment}>
        <label>学员<select value={form.studentId} onChange={(e) => setForm({ ...form, studentId: e.target.value })} required><option value="">请选择学员</option>{students.map((item) => <option key={item.id} value={item.id}>{item.displayName}（{item.login}）</option>)}</select></label>
        <label>套餐<select value={form.packageId} onChange={(e) => setForm({ ...form, packageId: e.target.value })} required><option value="">请选择有可用席位的启用套餐</option>{activePackages.map((item) => <option key={item.id} value={item.id}>{item.name} · 可用 {item.availableSeats} / {item.studentSeats}</option>)}</select></label>
        <label>线下收款登记<select value={form.paymentStatus} onChange={(e) => setForm({ ...form, paymentStatus: e.target.value })}><option value="UNRECORDED">未登记</option><option value="RECORDED">已登记</option><option value="WAIVED">免收 / 赠送</option></select></label>
        <label>备注<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength="2000" placeholder="可记录线下履约说明，不填写敏感支付凭证。" /></label>
        <button className="primary-button" disabled={busy || !activePackages.length}>{busy ? '处理中…' : '创建待开通单'}</button>
      </form></Panel>
      <Panel title="席位规则"><div className="card-list">{packages.map((item) => <article className="item-card" key={item.id}><strong>{item.name}</strong><p>已占 {item.occupiedSeats} / {item.studentSeats}，可用 {item.availableSeats} 个席位。</p><small>套餐停用前必须先处理全部生效开通单，避免误中断在学学员。</small></article>) || <Empty title="暂无套餐" body="请先在积分套餐页面配置套餐和学员席位。" />}</div></Panel>
    </div>
    <Panel title="开通记录"><div className="table-wrap"><table><thead><tr><th>学员 / 套餐</th><th>状态</th><th>线下登记</th><th>有效期</th><th>留痕</th><th>操作</th></tr></thead><tbody>{enrollmentData.items.length ? enrollmentData.items.map((item) => <tr key={item.id}><td><strong>{item.studentName}</strong><div className="muted">{item.packageName}</div></td><td><Status value={item.status} /></td><td><Status value={item.paymentStatus} /></td><td>{formatDate(item.startsAt)}<div className="muted">至 {formatDate(item.expiresAt)}</div></td><td>{item.eventCount || 0} 条<div className="muted">{item.lastEventAt ? formatDate(item.lastEventAt) : '—'}</div></td><td><div className="row-actions">{item.status === 'PENDING' && <><button className="text-button" disabled={busy} onClick={() => act(item, 'payment-record', { paymentStatus: 'RECORDED' })}>登记收款</button><button className="text-button" disabled={busy} onClick={() => act(item, 'activate')}>完成开通</button><button className="text-button" disabled={busy} onClick={() => act(item, 'void')}>作废</button></>}{item.status === 'ACTIVE' && <><button className="text-button" disabled={busy} onClick={() => act(item, 'suspend')}>停用</button><button className="text-button" disabled={busy} onClick={() => act(item, 'renew')}>续费</button></>}{item.status === 'SUSPENDED' && <><button className="text-button" disabled={busy} onClick={() => act(item, 'resume')}>恢复</button><button className="text-button" disabled={busy} onClick={() => act(item, 'renew')}>续费</button><button className="text-button" disabled={busy} onClick={() => act(item, 'void')}>作废</button></>}{item.status === 'EXPIRED' && <button className="text-button" disabled={busy} onClick={() => act(item, 'renew')}>续费并开通</button>}</div></td></tr>) : <tr><td colSpan="6"><Empty title="暂无开通记录" body="创建开通单后会在这里沉淀状态、有效期与完整操作留痕。" /></td></tr>}</tbody></table></div></Panel>
  </>;
}

function UsagePage({ api }) {
  const [filters, setFilters] = useState({ days: '30', modality: '', status: '', search: '' });
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)), [filters]);
  const overview = useData(() => api.get('org/billing/usage-overview?days=' + encodeURIComponent(filters.days)), [api, filters.days]);
  const records = useData(() => api.get('org/ai-usage?' + query.toString()), [api, query]);
  if (overview.loading) return <Loading />;
  if (overview.error) return <ErrorState error={overview.error} onRetry={overview.refresh} />;
  return <>
    <PageHeader eyebrow="积分经营" title="积分用量" description="查看机构余额、能力消耗、高频学员和每一笔真实用量。" actions={<button className="secondary-button" onClick={() => { overview.refresh(); records.refresh(); }}>刷新</button>} />
    <div className="metrics"><MetricCard label="机构余额" value={formatCredits(overview.data.balance)} hint="机构共享魔法石池" /><MetricCard label="累计入账" value={formatCredits(overview.data.totalCreditsIn)} tone="teal" /><MetricCard label="累计消耗" value={formatCredits(overview.data.totalCreditsSpent)} tone="orange" /><MetricCard label="能力类型" value={overview.data.modalities.length} hint={'近 ' + filters.days + ' 日'} tone="pink" /></div>
    <div className="split">
      <Panel title="能力汇总"><table><thead><tr><th>能力</th><th>调用</th><th>积分</th></tr></thead><tbody>{overview.data.modalities.map((item) => <tr key={item.modality}><td>{item.modality}</td><td>{item.calls}</td><td>{formatCredits(item.credits)}</td></tr>)}</tbody></table></Panel>
      <Panel title="Top 学员"><table><thead><tr><th>学员</th><th>调用</th><th>积分</th></tr></thead><tbody>{overview.data.topUsers.map((item) => <tr key={item.id}><td>{item.studentName}</td><td>{item.calls}</td><td>{formatCredits(item.credits)}</td></tr>)}</tbody></table></Panel>
    </div>
    <Panel title="用量明细">
      <div className="form-grid">
        <label>时间范围<select value={filters.days} onChange={(e) => setFilters({ ...filters, days: e.target.value })}><option value="1">近 1 日</option><option value="7">近 7 日</option><option value="30">近 30 日</option><option value="365">近 1 年</option></select></label>
        <label>能力<input value={filters.modality} placeholder="TEXT / IMAGE / MUSIC" onChange={(e) => setFilters({ ...filters, modality: e.target.value })} /></label>
        <label>状态<select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">全部</option><option value="SUCCESS">成功</option><option value="FAILED">失败</option><option value="BLOCKED">拦截</option></select></label>
        <label>关键词<input value={filters.search} placeholder="用户 / 项目 / 作品" onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label>
      </div>
      {records.loading ? <Loading label="正在读取用量明细…" /> : records.error ? <ErrorState error={records.error} onRetry={records.refresh} /> : records.data.items.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>用户</th><th>能力 / 模型</th><th>上下文</th><th>积分</th><th>状态</th></tr></thead><tbody>{records.data.items.map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}</td><td>{item.userName || item.userLogin || item.userId}</td><td>{item.modality}<div className="muted">{item.model}</div></td><td>{item.className || '非课堂调用'}{item.lessonTitle ? <div className="muted">课时：{item.lessonTitle}</div> : null}{item.projectTitle ? <div className="muted">项目：{item.projectTitle}</div> : null}{item.workTitle ? <div className="muted">作品：{item.workTitle}</div> : null}</td><td>{formatCredits(item.credits)}</td><td><Status value={item.status} />{item.failCode ? <div className="muted">{item.failCode}</div> : null}</td></tr>)}</tbody></table></div> : <Empty title="所选范围内暂无用量记录" />}
    </Panel>
  </>;
}

function billingCsvValue(value) {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}
function BillingAccountPage({ api, user }) {
  const overview = useData(() => api.get('org/billing/account-overview'), [api]);
  const [filters, setFilters] = useState({ direction: '', type: '', status: '', startDate: '', endDate: '' });
  const [form, setForm] = useState({ type: 'ORG_ADJUSTMENT_IN', credits: '', reason: '' });
  const [frozenForm, setFrozenForm] = useState({ frozenCredits: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState('');
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString(), [filters]);
  const entries = useData(() => api.get('org/billing/credit-entries?' + query), [api, query]);
  if (user?.role === 'TEACHER') return <>
    <PageHeader eyebrow="机构运营" title="积分账务" description="查看机构共享魔法石余额、充值订单与积分流水。" />
    <Panel title="权限说明"><Notice tone="info">账务工作台仅机构管理员可见。授课教师可在“积分用量”查看本机构用量汇总。</Notice></Panel>
  </>;
  async function refreshAll() { await Promise.all([overview.refresh(), entries.refresh()]); }
  async function submitAdjustment(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await api.post('org/billing/credit-adjustments', form);
      setMessage('人工账务调整已完成，记账后可用余额 ' + formatCredits(result.balanceAfter) + '。');
      setForm({ type: 'ORG_ADJUSTMENT_IN', credits: '', reason: '' });
      await refreshAll();
    } catch (error) { setMessage(error.message || '人工调整失败'); } finally { setBusy(false); }
  }
  async function submitFrozen(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = await api.put('org/billing/frozen-credits', frozenForm);
      setMessage('冻结积分已更新为 ' + formatCredits(result.frozenCredits) + '，可用余额 ' + formatCredits(result.availableBalance) + '。');
      setFrozenForm({ frozenCredits: '', reason: '' }); await refreshAll();
    } catch (error) { setMessage(error.message || '冻结设置失败'); } finally { setBusy(false); }
  }
  async function reverseEntry(item, action) {
    const reason = window.prompt(action === 'refund' ? '请输入退款 / 退回原因' : '请输入冲正原因', '');
    if (reason === null) return;
    if (!reason.trim()) return setMessage('处理原因必填。');
    setBusy(true); setMessage('');
    try {
      const result = await api.post(`org/billing/credit-entries/${item.id}/${action}`, { reason });
      setMessage((action === 'refund' ? '退款处理已完成' : '冲正处理已完成') + '，记账后可用余额 ' + formatCredits(result.balanceAfter) + '。');
      await refreshAll();
    } catch (error) { setMessage(error.message || '账务处理失败'); } finally { setBusy(false); }
  }
  async function exportCsv() {
    setExporting(true); setMessage('');
    try {
      const data = await api.get('org/billing/reconciliation/export');
      const header = (data.columns || []).map((column) => billingCsvValue(column.label)).join(',');
      const lines = (data.items || []).map((item) => (data.columns || []).map((column) => billingCsvValue(item[column.key])).join(','));
      const blob = new Blob(['\uFEFF' + [header, ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = data.fileName || '机构积分对账.csv';
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
      setMessage('已导出 ' + lines.length + ' 条积分流水，导出动作已写入审计。');
    } catch (error) { setMessage(error.message || '对账导出失败'); } finally { setExporting(false); }
  }
  if (overview.loading) return <Loading label="正在读取机构账务…" />;
  if (overview.error) return <ErrorState error={overview.error} onRetry={overview.refresh} />;
  const data = overview.data || {}; const reconciliation = data.reconciliation || {};
  return <>
    <PageHeader eyebrow="机构运营" title="积分账务" description="管理共享魔法石余额、冻结、人工调整、退款冲正和流水对账。" actions={<div className="row-actions"><button className="secondary-button" onClick={overview.refresh}>刷新</button><button className="primary-button" onClick={exportCsv} disabled={exporting}>{exporting ? '导出中…' : '导出对账 CSV'}</button></div>} />
    <Notice tone="info">当前未接入在线支付、支付回调或自动续费；充值订单仅展示真实订单。AI 任务成功后才扣积分，策略拦截和 provider 失败均记录 0 积分审计，不产生扣费，也无需自动退款。冻结只是账务控制，不代表收款能力。</Notice>
    {message ? <Notice tone={message.includes('失败') || message.includes('必填') ? 'danger' : 'success'}>{message}</Notice> : null}
    <div className="metrics">
      <MetricCard label="可用余额" value={formatCredits(data.availableBalance || 0)} hint="当前可消耗积分" />
      <MetricCard label="冻结积分" value={formatCredits(data.frozenCredits || 0)} hint="仅锁定，不计收支" tone="orange" />
      <MetricCard label="总余额" value={formatCredits(data.totalBalance || 0)} hint="可用 + 冻结" tone="teal" />
      <MetricCard label="对账状态" value={reconciliation.balanced ? '一致' : '不一致'} hint={reconciliation.balanced ? '流水复算与账面一致' : '差异 ' + formatCredits(reconciliation.difference || 0)} tone={reconciliation.balanced ? 'teal' : 'pink'} />
    </div>
    <div className="split">
      <Panel title="人工调整"><form onSubmit={submitAdjustment}>
        <label>调整方向<select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option value="ORG_ADJUSTMENT_IN">人工补入</option><option value="ORG_ADJUSTMENT_OUT">人工扣减</option></select></label>
        <label>积分<input type="number" min="1" step="1" value={form.credits} onChange={(event) => setForm({ ...form, credits: event.target.value })} required /></label>
        <label>原因<textarea value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} maxLength="500" placeholder="必须记录线下业务依据，不得虚构充值。" required /></label>
        <button className="primary-button" disabled={busy}>{busy ? '处理中…' : '提交人工调整'}</button>
      </form></Panel>
      <Panel title="冻结控制"><form onSubmit={submitFrozen}>
        <label>目标冻结积分<input type="number" min="0" step="1" value={frozenForm.frozenCredits} onChange={(event) => setFrozenForm({ ...frozenForm, frozenCredits: event.target.value })} placeholder={'当前冻结 ' + formatCredits(data.frozenCredits || 0)} required /></label>
        <label>原因<textarea value={frozenForm.reason} onChange={(event) => setFrozenForm({ ...frozenForm, reason: event.target.value })} maxLength="500" placeholder="填写冻结或解冻的业务原因。" required /></label>
        <button className="primary-button" disabled={busy}>{busy ? '处理中…' : '更新冻结积分'}</button>
      </form><div className="muted">可用余额 + 冻结积分 = 流水复算总余额；冻结流水只留痕，不计入收入或消耗。</div></Panel>
    </div>
    <div className="split">
      <Panel title="充值订单"><table><thead><tr><th>订单号</th><th>金额</th><th>魔法石</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{(data.orders || []).map((item) => <tr key={item.id}><td>{item.orderNo}</td><td>¥{(item.amountFen / 100).toFixed(2)}</td><td>{formatCredits(item.credits)}{item.bonusCredits ? <div className="muted">赠 {formatCredits(item.bonusCredits)}</div> : null}</td><td><Status value={item.status} /></td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></Panel>
      <Panel title="对账摘要"><table><tbody><tr><td>累计收入</td><td>{formatCredits(data.totalCreditsIn || 0)}</td></tr><tr><td>累计消耗</td><td>{formatCredits(data.totalCreditsSpent || 0)}</td></tr><tr><td>流水收入合计</td><td>{formatCredits(reconciliation.ledgerCreditsIn || 0)}</td></tr><tr><td>流水消耗合计</td><td>{formatCredits(reconciliation.ledgerCreditsOut || 0)}</td></tr><tr><td>流水条数</td><td>{reconciliation.entryCount || 0}</td></tr><tr><td>最近流水</td><td>{reconciliation.latestEntryAt ? formatDate(reconciliation.latestEntryAt) : '暂无'}</td></tr></tbody></table><div className="muted">{reconciliation.rule}</div></Panel>
    </div>
    <Panel title="积分流水">
      <div className="form-grid">
        <label>方向<select value={filters.direction} onChange={(event) => setFilters({ ...filters, direction: event.target.value })}><option value="">全部</option><option value="IN">收入</option><option value="OUT">支出</option></select></label>
        <label>类型<input value={filters.type} placeholder="ORG_ADJUSTMENT_IN / AI_TEXT" onChange={(event) => setFilters({ ...filters, type: event.target.value })} /></label>
        <label>状态<select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">全部</option><option value="EFFECTIVE">有效</option><option value="VOIDED">已处理</option></select></label>
        <label>开始日期<input type="date" value={filters.startDate} onChange={(event) => setFilters({ ...filters, startDate: event.target.value })} /></label>
        <label>结束日期<input type="date" value={filters.endDate} onChange={(event) => setFilters({ ...filters, endDate: event.target.value })} /></label>
      </div>
      {entries.loading ? <Loading label="正在读取积分流水…" /> : entries.error ? <ErrorState error={entries.error} onRetry={entries.refresh} /> : (entries.data?.items || []).length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>方向 / 积分</th><th>余额</th><th>状态</th><th>操作</th></tr></thead><tbody>{entries.data.items.map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}</td><td>{item.type}{item.reversalOf ? <div className="muted">源：{item.reversalOf}</div> : null}<div className="muted">{item.reason || item.modality || '—'}</div></td><td>{item.direction === 'IN' ? '+' : '-'}{formatCredits(item.credits)}</td><td>{formatCredits(item.balanceAfter)}</td><td><Status value={item.status} /></td><td><div className="row-actions"><button className="text-button" disabled={busy || item.status !== 'EFFECTIVE' || ['FROZEN_HOLD','FROZEN_RELEASE'].includes(item.type)} onClick={() => reverseEntry(item, 'refund')}>退款</button><button className="text-button" disabled={busy || item.status !== 'EFFECTIVE' || ['FROZEN_HOLD','FROZEN_RELEASE'].includes(item.type)} onClick={() => reverseEntry(item, 'reverse')}>冲正</button></div></td></tr>)}</tbody></table></div> : <Empty title="当前筛选范围暂无积分流水" />}
    </Panel>
  </>;
}

function OrgInbox({ api, user }) {
  const inbox = useData(() => api.get('org/inbox'), [api]);
  const [form, setForm] = useState({ title: '', body: '', roles: ['TEACHER', 'STUDENT'], pinned: false });
  const [message, setMessage] = useState(''); const [saving, setSaving] = useState(false);
  async function send(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try { await api.post('org/inbox', form); setForm({ title: '', body: '', roles: ['TEACHER', 'STUDENT'], pinned: false }); setMessage('机构通知已发送。'); inbox.refresh(); } catch (err) { setMessage(err.message); } finally { setSaving(false); }
  }
  async function read(item) { try { await api.put(`org/inbox/${item.id}/read`, {}); inbox.refresh(); } catch (err) { setMessage(err.message); } }
  function toggleRole(role) { setForm((old) => ({ ...old, roles: old.roles.includes(role) ? old.roles.filter((item) => item !== role) : [...old.roles, role] })); }
  const isAdmin = user?.role === 'ORG_ADMIN';
  return <>
    <PageHeader eyebrow="机构运营" title="站内信" description="接收平台公告与机构内部通知，已读状态由服务端记录。" actions={<div className="row-actions"><button className="secondary-button" onClick={() => api.put('org/inbox/read-all', {}).then(inbox.refresh).catch((err) => setMessage(err.message))}>全部标记已读</button><button className="secondary-button" onClick={inbox.refresh}>刷新</button></div>} />
    <div className="metrics"><MetricCard label="收件总数" value={inbox.data?.total || 0} hint="当前账号可见" /><MetricCard label="未读消息" value={inbox.data?.unread || 0} hint="需要关注的通知" tone="orange" /></div>
    {isAdmin ? <Panel title="发送机构通知"><form onSubmit={send}><div className="form-grid"><label>标题<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required /></label><label>接收角色<div className="row-actions top-gap">{[['TEACHER', '教师'], ['STUDENT', '学员']].map(([role, label]) => <button type="button" className={form.roles.includes(role) ? 'secondary-button' : 'text-button'} key={role} onClick={() => toggleRole(role)}>{label}</button>)}</div></label></div><label>内容<textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required /></label>{message ? <Notice tone={message.includes('失败') || message.includes('不能为空') ? 'danger' : 'success'}>{message}</Notice> : null}<button className="primary-button" disabled={saving}>{saving ? '发送中…' : '发送通知'}</button></form></Panel> : <Notice tone="info">授课教师可以查看和标记消息；机构内部通知由机构管理员发送。</Notice>}
    <Panel title="消息列表">{inbox.loading ? <Loading /> : inbox.error ? <ErrorState error={inbox.error} onRetry={inbox.refresh} /> : inbox.data.items.length ? <div className="card-list">{inbox.data.items.map((item) => <article className="item-card" key={item.id} style={{ borderColor: item.readAt ? undefined : '#c8baf7', background: item.readAt ? '#fff' : '#faf8ff' }}><div className="row-actions"><Status value={item.kind} /><strong>{item.pinned ? '📌 ' : ''}{item.title}</strong><span className="muted">{formatDate(item.publishAt || item.createdAt)}</span>{!item.readAt ? <button className="text-button" onClick={() => read(item)}>标记已读</button> : <span className="muted">已读</span>}</div><p>{item.body}</p>{item.senderName ? <small className="muted">发送人：{item.senderName}</small> : null}{item.targetUrl ? <div className="top-gap"><span className="muted">跳转：{item.targetUrl}</span></div> : null}</article>)}</div> : <Empty title="暂无站内信" body="平台公告或机构通知送达后会显示在这里。" />}</Panel>
  </>;
}

function OrgFileUpload({ api, onDone }) {
  const [file, setFile] = useState(null); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event) { event.preventDefault(); if (!file) return setMessage('请选择文件'); setBusy(true); setMessage(''); try { await api.upload('org/file-assets/upload', file, { category: 'MEDIA_ASSET', visibility: 'ORG' }); setMessage('文件上传成功'); setFile(null); onDone?.(); } catch (error) { setMessage(error.message); } finally { setBusy(false); } }
  return <Panel title="机构文件上传"><form onSubmit={submit} className="form-grid"><label>选择教学或宣传文件<input type="file" onChange={(event) => setFile(event.target.files?.[0] || null)} disabled={busy} /></label><div className="row-actions"><button className="primary-button" disabled={busy || !file}>{busy ? '上传中…' : '上传文件'}</button>{message ? <span className="muted">{message}</span> : null}</div></form></Panel>;
}

function OrgMaterials({ api, user }) {
  const materials = useData(() => api.get('org/materials'), [api]);
  const [message, setMessage] = useState('');
  async function useMaterial(item) { try { await api.post(`org/materials/${item.id}/events`, { eventType: 'USE' }); setMessage(`已记录使用：${item.title}`); materials.refresh(); } catch (err) { setMessage(err.message); } }
  async function openMaterial(item) { try { const result = await api.post(`org/materials/${item.id}/events`, { eventType: 'DOWNLOAD' }); if (result.resourceUrl) window.open(result.resourceUrl, '_blank', 'noopener,noreferrer'); } catch (err) { setMessage(err.message); } }
  return <>
    <PageHeader eyebrow="机构运营" title="宣传物料" description="查看平台下发的课程介绍、招生海报和活动资料。" actions={<button className="secondary-button" onClick={materials.refresh}>刷新</button>} />
    <Notice tone="info">物料访问会记录 VIEW / USE / DOWNLOAD 事件。没有配置真实资源地址的物料不会显示虚假下载链接。</Notice>
    {user?.role === 'ORG_ADMIN' ? <OrgFileUpload api={api} onDone={materials.refresh} /> : null}
    {message ? <Notice tone="success">{message}</Notice> : null}
    <Panel title="可用物料">{materials.loading ? <Loading /> : materials.error ? <ErrorState error={materials.error} onRetry={materials.refresh} /> : materials.data.items.length ? <div className="card-list">{materials.data.items.map((item) => <article className="item-card" key={item.id}><div className="row-actions"><strong>{item.title}</strong><Status value={item.category} /><span className="muted">{item.visibility === 'ALL_ORGS' ? '全机构' : '定向授权'}</span></div><p>{item.description || '暂无说明'}</p><div className="row-actions top-gap"><button className="secondary-button" onClick={() => useMaterial(item)}>记录使用</button>{item.resourceConfigured ? <button className="primary-button" onClick={() => openMaterial(item)}>打开资源</button> : <span className="muted">资源待配置</span>}</div></article>)}</div> : <Empty title="暂无可用物料" body="平台配置物料后会按机构授权范围显示。" />}</Panel>
  </>;
}

function OrgPage({ kind, user }) {
  const teacher = user?.role === 'TEACHER';
  const pages = {
    inbox: ['站内信', '查看平台与机构的教学、运营和系统通知。', ['课堂通知', '开课、结束、作品点评等信息将统一沉淀'], ['运营消息', '课包、充值与平台活动通知统一送达']],
    courses: ['课程中心', '浏览机构已开通课包、课时与授课资源，老师可从这里进入课堂。', ['标准课包', '平台下发的课程与课时内容'], ['授课资源', 'PPT、HTML 互动课件与课堂备注']],
    'work-data': ['作品数据中心', '从作品数量、发布趋势和热门成果了解校区的教学沉淀。', ['近 7 日趋势', '作品发布与浏览趋势'], ['优秀作品', '按互动与完成度查看校区案例']],
    packages: ['积分套餐', '维护面向学员的套餐、有效期与可使用的 AI 创作能力。', ['套餐配置', '月额度、有效期与能力开关'], ['开通规则', '学员开通单、履约与变更记录']],
    enrollment: ['学员开通', '登记学员套餐、实收状态与履约进度，把线下收款过程沉淀为机构记录。', ['开通单', '选择学员、商品和有效期'], ['履约记录', '支持标记收款、完成与作废']],
    recharge: ['积分充值', '为机构共享魔法石池充值，保持课堂 AI 用量稳定可控。', ['机构余额', '按机构统一充值与余额提醒'], ['发票申请', '充值订单与申请发票统一管理']],
    usage: ['积分用量', '查看余额、今日 / 近 7 日 / 近 30 日用量以及高频使用者。', ['用量概览', '按能力类型与时间范围汇总'], ['明细记录', '查看用户、项目与课堂上下文']],
    materials: ['宣传物料', '下载平台配置的招生海报、课程介绍与活动物料包。', ['课程介绍', '用于咨询、试听与招生沟通'], ['活动素材', '机构可下载并按校区使用']],
    hackathon: ['黑客松', '查看平台赛季、机构可见开关和可推送的学员作品。', ['赛季活动', '主题、时间与奖励信息'], ['作品推送', '从校区优秀作品中选择参赛成果']],
    afee: ['阿飞提醒', '管理机构消息提醒与授权访客通知，让教学运营信息及时送达。', ['提醒开关', '机构管理员可统一管理提醒策略'], ['访客授权', '管理可接收作品来访通知的成员']],
  };
  const [title, description, cards] = pages[kind];
  return <><PageHeader eyebrow={teacher ? 'AI魔法学院 · 教学首页' : 'AI魔法学院 · 机构运营'} title={title} description={description} actions={<button className="primary-button">配置 / 新建</button>} /><div className="metrics">{cards.map((item, index) => <MetricCard key={item[0]} label={item[0]} value={index ? '待接入' : '准备就绪'} hint={item[1]} tone={index ? 'teal' : 'violet'} />)}</div><Panel title="功能接入说明"><Notice tone="info">页面已按 AI魔法学院机构端的信息架构建立。计费、通知、开通和数据中心需要相应后端接口后才会写入真实业务数据；当前不会使用模拟记录冒充真实数据。</Notice></Panel></>;
}

function App() {
  const [session, setSession] = useState(readSession); const navigate = useNavigate();
  const api = useMemo(() => createApiClient({ getToken: () => session?.token, onUnauthorized: () => { clearSession(); setSession(null); navigate('/login'); } }), [session?.token, navigate]);
  useEffect(() => { if (session?.token) api.me().then((user) => setSession(writeSession({ ...session, user, organization: user.organization }))).catch(() => {}); }, [session?.token]);
  async function login(credentials) { const data = await api.login(credentials); if (!['ORG_ADMIN', 'TEACHER'].includes(data.user.role)) throw new ApiError('该账号没有机构教务权限', { code: 'ROLE_MISMATCH' }); setSession(writeSession(data)); navigate('/dashboard'); }
  async function logout() { try { await api.logout(); } catch { /* local logout still succeeds */ } clearSession(); setSession(null); navigate('/login'); }
  if (!session) return <Routes><Route path="*" element={<LoginPanel title="机构教务工作台" description="管理班级、课堂、成员和学生创作成果。" clientType="org" demos={demos} onLogin={login} />} /></Routes>;
  if (!['ORG_ADMIN', 'TEACHER'].includes(session.user?.role)) return <LoginPanel title="机构教务工作台" description="当前会话没有机构教务权限。" clientType="org" demos={demos} onLogin={login} />;
  const visibleNavigation = navigation.filter((item) => !item.adminOnly || session.user?.role === 'ORG_ADMIN');
  return <AppShell product="AI 魔法学院" roleLabel={session.user.role === 'TEACHER' ? '授课教师' : '机构管理员'} user={session.user} navigation={visibleNavigation} onLogout={logout}><Routes><Route path="/dashboard" element={<Dashboard api={api} />} /><Route path="/tasks" element={<TeachingTasks api={api} />} /><Route path="/classes" element={<Classes api={api} user={session.user} />} /><Route path="/members" element={<Members api={api} user={session.user} />} /><Route path="/works" element={<Works api={api} />} /><Route path="/inbox" element={<OrgInbox api={api} user={session.user} />} /><Route path="/courses" element={<OrgCourses api={api} />} /><Route path="/courses/:seriesId" element={<OrgCourses api={api} />} /><Route path="/work-data" element={<WorkDataPage api={api} user={session.user} />} /><Route path="/packages" element={<BillingPackages api={api} user={session.user} />} /><Route path="/enrollment" element={<EnrollmentPage api={api} user={session.user} />} /><Route path="/account-requests" element={<AccountRequests api={api} />} /><Route path="/recharge" element={<BillingAccountPage api={api} user={session.user} />} /><Route path="/usage" element={<UsagePage api={api} />} /><Route path="/materials" element={<OrgMaterials api={api} user={session.user} />} /> <Route path="/help-feedback" element={<HelpFeedbackPage api={api} />} /><Route path="/hackathon" element={<OrgPage kind="hackathon" user={session.user} />} /><Route path="/afee" element={<OrgPage kind="afee" user={session.user} />} /><Route path="*" element={<Navigate to="/dashboard" replace />} /></Routes></AppShell>;
}
createRoot(document.getElementById('root')).render(<BrowserRouter basename={APP_BASENAME}><App /></BrowserRouter>);
