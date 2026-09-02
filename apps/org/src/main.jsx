import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { CanvasEditor } from '@platform/canvas';
import { ApiError, AppShell, clearSession, createApiClient, Empty, ErrorState, formatCredits, formatDate, Loading, LoginPanel, MetricCard, Notice, PageHeader, Panel, readSession, Status, writeSession } from '@platform/shared';
import '@platform/shared/styles.css';

const navigation = [{ to: '/dashboard', icon: '◈', label: '机构总览' }, { to: '/classes', icon: '▦', label: '班级与课堂' }, { to: '/members', icon: '♙', label: '成员管理' }, { to: '/works', icon: '✧', label: '作品点评' }];
const demos = [{ label: '机构管理员', login: 'org-admin', password: 'org123' }, { label: '授课教师', login: 'teacher-1', password: 'teach123' }];

function useData(load, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const refresh = async () => { setState((old) => ({ ...old, loading: true, error: null })); try { setState({ loading: false, error: null, data: await load() }); } catch (error) { setState({ loading: false, error, data: null }); } };
  useEffect(() => { refresh(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, refresh };
}

function Dashboard({ api }) {
  const { loading, error, data, refresh } = useData(() => api.get('org/overview'), [api]);
  if (loading) return <Loading />; if (error) return <ErrorState error={error} onRetry={refresh} />;
  return <><PageHeader eyebrow="机构教务" title={data.org.name} description="实时掌握班级开课、作品和机构积分余额。" /><div className="metrics"><MetricCard label="活跃班级" value={data.activeClasses} hint={`${data.activeSessions} 个课堂正在进行`} /><MetricCard label="学员" value={data.students} hint={`${data.teachers} 位教师`} tone="teal" /><MetricCard label="作品" value={data.works} hint="等待教师点评" tone="orange" /><MetricCard label="可用积分" value={formatCredits(data.creditBalance)} hint={`近 7 日消耗 ${formatCredits(data.usage7)}`} tone="pink" /></div><Panel title="本机构状态"><div className="row-actions"><Status value={data.org.status} /><span className="muted">合同到期：{formatDate(data.org.contractExpiresAt)}</span><span className="muted">教师席位：{data.org.teacherUsedSeats} / {data.org.teacherSeats}</span></div></Panel></>;
}

function Classes({ api, user }) {
  const classes = useData(() => api.get('org/classes'), [api]);
  const courses = useData(() => api.get('org/course-series'), [api]);
  const [curriculum, setCurriculum] = useState({ loading: false, error: null, byClass: {} });
  const [selected, setSelected] = useState({});
  const [message, setMessage] = useState('');
  const [form, setForm] = useState({ name: '', defaultSeriesId: '', usageMode: 'CLASS_ONLY' });

  useEffect(() => {
    let cancelled = false;
    const classItems = classes.data?.items;
    if (!classItems) return undefined;
    if (!classItems.length) {
      setCurriculum({ loading: false, error: null, byClass: {} });
      return undefined;
    }

    setCurriculum((current) => ({ ...current, loading: true, error: null }));
    Promise.all(classItems.map(async (item) => [item.id, (await api.get(`org/classes/${item.id}/curriculum`)).items || []]))
      .then((entries) => {
        if (!cancelled) setCurriculum({ loading: false, error: null, byClass: Object.fromEntries(entries) });
      })
      .catch((error) => {
        if (!cancelled) setCurriculum({ loading: false, error, byClass: {} });
      });

    return () => { cancelled = true; };
  }, [api, classes.data]);

  async function start(classId) {
    const lessons = curriculum.byClass[classId] || [];
    const lessonId = selected[classId];
    if (!lessons.length) return setMessage('该班级尚未配置课单，无法开始课堂。');
    if (!lessonId) return setMessage('请先选择本班课单中的课时。');
    try {
      await api.post(`org/classes/${classId}/sessions/start`, { lessonId, capabilities: { allowImage: true, allowMusic: true } });
      setMessage('课堂已开始。');
      classes.refresh();
    } catch (err) { setMessage(err.message); }
  }

  async function end(classId, sessionId) {
    try {
      await api.post(`org/classes/${classId}/sessions/${sessionId}/end`, { reason: 'MANUAL' });
      setMessage('课堂已结束。');
      classes.refresh();
    } catch (err) { setMessage(err.message); }
  }

  async function create(event) {
    event.preventDefault();
    try {
      await api.post('org/classes', { ...form, defaultSeriesId: form.defaultSeriesId || null });
      setForm({ name: '', defaultSeriesId: '', usageMode: 'CLASS_ONLY' });
      setMessage('班级已创建。请继续配置该班级课单后再开课。');
      classes.refresh();
    } catch (err) { setMessage(err.message); }
  }

  const refresh = () => { classes.refresh(); courses.refresh(); };
  const isSuccess = message.includes('已开始') || message.includes('已结束') || message.includes('已创建');

  return <>
    <PageHeader eyebrow="教学管理" title="班级与课堂" description="配置班级课单，并由教师发起、结束课堂。" />
    <div className="split">
      <Panel title="新建班级">
        <form onSubmit={create}>
          <label>班级名称<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label>默认课包<select value={form.defaultSeriesId} onChange={(e) => setForm({ ...form, defaultSeriesId: e.target.value })}><option value="">稍后配置</option>{courses.data?.items?.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label>
          <label>使用模式<select value={form.usageMode} onChange={(e) => setForm({ ...form, usageMode: e.target.value })}><option value="CLASS_ONLY">仅跟随课堂</option><option value="ALWAYS_AVAILABLE">始终可用</option></select></label>
          <button className="primary-button">创建班级</button>
        </form>
      </Panel>
      <Panel title="课堂规则">
        <Notice>教师只可管理自己担任教师的班级。开课选项仅来自本班已配置且已授权的课单。</Notice>
        {message && <Notice tone={isSuccess ? 'success' : 'danger'}>{message}</Notice>}
      </Panel>
    </div>
    <Panel title="我的可管理班级" actions={<button className="secondary-button" onClick={refresh}>刷新</button>}>
      {classes.loading || courses.loading ? <Loading /> : classes.error ? <ErrorState error={classes.error} onRetry={refresh} /> : classes.data.items.length ? <div className="card-list">
        {curriculum.error && <Notice tone="danger">班级课单加载失败：{curriculum.error.message}</Notice>}
        {classes.data.items.map((item) => {
          const lessons = curriculum.byClass[item.id] || [];
          const canStart = !curriculum.loading && !curriculum.error && lessons.length > 0;
          return <article className="item-card" key={item.id}>
            <div className="row-actions"><h3>{item.name}</h3><Status value={item.status} />{item.currentSessionId && <Status value="ACTIVE SESSION" />}</div>
            <p>使用模式：{item.usageMode}　教师：{item.teacherName || (item.teacherId === user.id ? user.displayName : '未设置')}</p>
            <div className="row-actions">
              {item.currentSessionId ? <button className="primary-button" onClick={() => end(item.id, item.currentSessionId)}>结束当前课堂</button> : curriculum.loading ? <span className="muted">正在加载本班课单…</span> : lessons.length ? <><select value={selected[item.id] || ''} onChange={(e) => setSelected({ ...selected, [item.id]: e.target.value })}><option value="">选择要开课的课时</option>{lessons.map((lesson) => <option key={lesson.lessonId} value={lesson.lessonId}>第 {lesson.sort} 课 · {lesson.title}</option>)}</select><button className="primary-button" onClick={() => start(item.id)} disabled={!canStart}>开始课堂</button></> : <span className="muted">尚未配置课单，请先在教务接口中为该班级设置课程。</span>}
            </div>
          </article>;
        })}
      </div> : <Empty title="暂无可管理班级" body="请先创建班级，再配置学生和课程。" />}
    </Panel>
  </>;
}

function Members({ api }) {
  const { loading, error, data, refresh } = useData(() => api.get('org/users'), [api]);
  if (loading) return <Loading />; if (error) return <ErrorState error={error} onRetry={refresh} />;
  return <><PageHeader eyebrow="机构成员" title="教师与学生" description="成员管理权限由机构管理员或被授权教师控制。" /><Panel title="成员列表" actions={<button className="secondary-button" onClick={refresh}>刷新</button>}>{data.items.length ? <div className="table-wrap"><table><thead><tr><th>姓名</th><th>角色</th><th>登录名</th><th>本期额度</th><th>状态</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td>{item.displayName}</td><td>{item.role}</td><td>{item.login}</td><td>{item.role === 'STUDENT' ? formatCredits(item.creditsRemaining) : '—'}</td><td><Status value={item.status} /></td></tr>)}</tbody></table></div> : <Empty />}</Panel></>;
}

function nodeLabel(snapshot, nodeId) {
  const node = snapshot?.nodes?.find((item) => item.id === nodeId);
  if (!node) return '整体作品';
  const data = node.data || {};
  return data.name || data.place || data.caption || data.text || data.title || nodeId;
}

function Works({ api }) {
  const { loading, error, data, refresh } = useData(() => api.get('org/works?includeSnapshot=true'), [api]);
  const [message, setMessage] = useState('');
  const [selectedWork, setSelectedWork] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [teacherComment, setTeacherComment] = useState('');
  const [annotationContent, setAnnotationContent] = useState('');
  const [annotationNodeId, setAnnotationNodeId] = useState('');

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
    <Panel title="作品列表" actions={<button className="secondary-button" onClick={refresh}>刷新</button>}>
      {data.items.length ? <div className="table-wrap"><table><thead><tr><th>作品</th><th>学生</th><th>班级 / 课时</th><th>提交时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><strong>{item.title}</strong><div className="muted">{item.description || '暂无说明'}</div></td><td>{item.studentName}</td><td>{item.className || '—'}<div className="muted">{item.courseLessonTitle || '—'}</div></td><td>{formatDate(item.submittedAt)}</td><td><Status value={item.status} /></td><td><div className="row-actions"><button className="text-button" onClick={() => openWork(item)}>查看与点评</button><button className="text-button" onClick={() => review(item, 'APPROVED')}>通过</button><button className="text-button" onClick={() => review(item, 'PUBLISHED')}>发布</button></div></td></tr>)}</tbody></table></div> : <Empty title="尚未收到作品" />}
    </Panel>
    {selectedWork && <>
      <Panel title={`画布预览与整体点评 · ${selectedWork.title}`} actions={<button className="secondary-button" onClick={() => setSelectedWork(null)}>关闭预览</button>}>
        <div className="row-actions canvas-meta"><span className="muted">学生：{selectedWork.studentName}</span><span className="muted">提交时间：{formatDate(selectedWork.submittedAt)}</span><Status value={selectedWork.status} /></div>
        <label>整体点评<textarea value={teacherComment} maxLength={2000} placeholder="告诉学生作品做得好的地方，以及下一步可以怎样改进。" onChange={(event) => setTeacherComment(event.target.value)} /></label>
        <div className="row-actions"><button className="secondary-button" onClick={() => review(selectedWork, 'APPROVED', teacherComment)}>保存点评并通过</button><button className="primary-button" onClick={() => review(selectedWork, 'PUBLISHED', teacherComment)}>保存点评并发布</button></div>
        <CanvasEditor key={selectedWork.id} initialSnapshot={selectedWork.canvasSnapshot} readOnly />
      </Panel>
      <Panel title="画布卡片批注" description="选择某张卡片可发送针对性建议；不选卡片即为整张作品的补充点评。">
        <form onSubmit={addAnnotation}><label>关联卡片<select value={annotationNodeId} onChange={(event) => setAnnotationNodeId(event.target.value)}><option value="">整张作品（不关联卡片）</option>{(selectedWork.canvasSnapshot?.nodes || []).map((node) => <option key={node.id} value={node.id}>{nodeLabel(selectedWork.canvasSnapshot, node.id)}</option>)}</select></label><label>批注内容<textarea value={annotationContent} required maxLength={1000} placeholder="例如：这里可以补充角色为什么要这样做。" onChange={(event) => setAnnotationContent(event.target.value)} /></label><button className="primary-button">发送批注</button></form>
        {annotationsLoading ? <Loading label="正在读取点评…" /> : annotations.length ? <div className="card-list">{annotations.map((annotation) => <article className="item-card" key={annotation.id}><div className="row-actions"><strong>{annotation.nodeId ? `卡片：${nodeLabel(selectedWork.canvasSnapshot, annotation.nodeId)}` : '整体补充点评'}</strong><Status value={annotation.resolvedAt ? 'APPROVED' : 'PENDING'} /></div><p>{annotation.content}</p><p className="muted">{annotation.authorName} · {formatDate(annotation.createdAt)}{annotation.resolvedAt ? ` · 已于 ${formatDate(annotation.resolvedAt)} 完成` : ''}</p><button className="text-button" onClick={() => toggleResolved(annotation)}>{annotation.resolvedAt ? '标记为待跟进' : '标记为已完成'}</button></article>)}</div> : <Empty title="还没有画布批注" body="可以先在上方写一条具体建议。" />}
      </Panel>
    </>}
  </>;
}

function OrgCourses({ api }) {
  const { loading, error, data, refresh } = useData(() => api.get('org/course-series'), [api]);
  const [expanded, setExpanded] = useState('');
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  const sourceLabels = { PLATFORM: '平台课包', ORG: '机构自有' };
  const visibilityLabels = { ALL_ORGS: '全部机构可见', ASSIGNED_ORGS: '平台授权', PRIVATE: '私有' };
  return <>
    <PageHeader eyebrow="教学资源" title="课程中心" description="查看本机构已开通的平台课包、机构课包与课时安排。" actions={<button className="secondary-button" onClick={refresh}>刷新</button>} />
    <div className="metrics"><MetricCard label="可用课包" value={data.items.length} hint="仅统计当前已发布课程" /><MetricCard label="平台授权课包" value={data.items.filter((item) => item.ownerType === 'PLATFORM' && item.assignedToCurrentOrg).length} hint="平台单独授权后可见" tone="teal" /><MetricCard label="总课时" value={data.items.reduce((sum, item) => sum + item.lessonCount, 0)} hint="已发布课时" tone="orange" /></div>
    <Panel title="课程列表">
      {data.items.length ? <div className="card-list">{data.items.map((course) => <article className="item-card" key={course.id}>
        <div className="row-actions"><h3>{course.title}</h3><Status value={course.status} /><span className="muted">{sourceLabels[course.ownerType] || course.ownerType}</span><span className="muted">{visibilityLabels[course.visibility] || course.visibility}</span><span className="muted">v{course.version}</span></div>
        <p>{course.description || '暂无课程说明'}</p>
        <p className="muted">{course.lessonCount} 节课时{course.ownerType === 'PLATFORM' && course.assignedToCurrentOrg ? ' · 平台已授权' : ''}</p>
        <div className="row-actions"><button className="text-button" onClick={() => setExpanded(expanded === course.id ? '' : course.id)}>{expanded === course.id ? '收起课时' : '查看课时'}</button><span className="muted">更新：{formatDate(course.updatedAt)}</span></div>
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
    bonusCredits: item.bonusCredits ?? 0, durationDays: item.durationDays ?? 30,
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
      const payload = { ...form, priceFen: Number(form.priceFen), monthlyCredits: Number(form.monthlyCredits), bonusCredits: Number(form.bonusCredits), durationDays: Number(form.durationDays) };
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
            <label>有效期（天）<input type="number" min="1" max="3650" value={form.durationDays} onChange={(e) => setValue('durationDays', e.target.value)} /></label>
          </div>
          <label>AI 能力</label>
          <div className="row-actions">{packageCapabilities.map(([key, label]) => <label key={key} className="checkbox-option"><input type="checkbox" checked={form.capabilities[key]} onChange={(e) => setCapability(key, e.target.checked)} />{label}</label>)}</div>
          {message && <Notice tone={message === '套餐已保存。' ? 'success' : 'danger'}>{message}</Notice>}
          <div className="row-actions"><button className="primary-button" disabled={saving}>{saving ? '保存中…' : editingId ? '保存修改' : '创建套餐'}</button>{editingId && <button type="button" className="secondary-button" onClick={() => { setEditingId(''); setForm(packageFormFrom()); }}>取消编辑</button>}</div>
        </form>
      </Panel>}
      <Panel title="套餐列表">
        {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={refresh} /> : data.items.length ? <div className="table-wrap"><table><thead><tr><th>套餐</th><th>价格</th><th>积分</th><th>有效期</th><th>AI 能力</th><th>状态</th>{isAdmin && <th>操作</th>}</tr></thead><tbody>{data.items.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>¥{(item.priceFen / 100).toFixed(2)}</td><td>{formatCredits(item.monthlyCredits)} / 月{item.bonusCredits ? <div className="muted">赠送 {formatCredits(item.bonusCredits)}</div> : null}</td><td>{item.durationDays} 天</td><td>{packageCapabilities.filter(([key]) => item.capabilities[key]).map(([, label]) => label).join(' / ') || '未开放'}</td><td><Status value={item.status} /></td>{isAdmin && <td><div className="row-actions"><button className="text-button" onClick={() => { setEditingId(item.id); setForm(packageFormFrom(item)); setMessage(''); }}>编辑</button><button className="text-button" onClick={() => toggle(item)}>{item.status === 'ACTIVE' ? '停用' : '启用'}</button></div></td>}</tr>)}</tbody></table></div> : <Empty title="尚未配置套餐" />}
      </Panel>
    </div>
  </>;
}

function UsagePage({ api }) {
  const [filters, setFilters] = useState({ days: '30', modality: '', status: '', search: '' });
  const query = useMemo(() => new URLSearchParams(Object.entries(filters).filter(([, value]) => value)), [filters]);
  const overview = useData(() => api.get('org/billing/usage-overview?days=' + encodeURIComponent(filters.days)), [api, filters.days]);
  const records = useData(() => api.get('org/billing/usage-records?' + query.toString()), [api, query]);
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
        <label>能力<input value={filters.modality} placeholder="TEXT / IMAGE / AUDIO" onChange={(e) => setFilters({ ...filters, modality: e.target.value })} /></label>
        <label>状态<select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}><option value="">全部</option><option value="SUCCESS">成功</option><option value="FAILED">失败</option><option value="BLOCKED">拦截</option></select></label>
        <label>关键词<input value={filters.search} placeholder="用户 / 项目 / 作品" onChange={(e) => setFilters({ ...filters, search: e.target.value })} /></label>
      </div>
      {records.loading ? <Loading label="正在读取用量明细…" /> : records.error ? <ErrorState error={records.error} onRetry={records.refresh} /> : records.data.items.length ? <div className="table-wrap"><table><thead><tr><th>时间</th><th>用户</th><th>能力 / 模型</th><th>上下文</th><th>积分</th><th>状态</th></tr></thead><tbody>{records.data.items.map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}</td><td>{item.userName || item.userLogin || item.userId}</td><td>{item.modality}<div className="muted">{item.model}</div></td><td>{item.className || '非课堂调用'}{item.projectTitle ? <div className="muted">项目：{item.projectTitle}</div> : null}{item.workTitle ? <div className="muted">作品：{item.workTitle}</div> : null}</td><td>{formatCredits(item.credits)}</td><td><Status value={item.status} /></td></tr>)}</tbody></table></div> : <Empty title="所选范围内暂无用量记录" />}
    </Panel>
  </>;
}

function BillingAccountPage({ api, user }) {
  const overview = useData(() => api.get('org/billing/account-overview'), [api]);
  if (user?.role === 'TEACHER') return <>
    <PageHeader eyebrow="机构运营" title="积分充值" description="查看机构共享魔法石余额、充值订单与积分流水。" />
    <Panel title="权限说明"><Notice tone="info">账务视图仅机构管理员可见。授课教师可在“积分用量”查看本机构用量汇总。</Notice></Panel>
  </>;
  return <>
    <PageHeader eyebrow="机构运营" title="积分充值" description="查看共享魔法石余额、充值订单与积分流水；在线支付接入前不做虚假充值。" actions={<button className="secondary-button" onClick={overview.refresh}>刷新</button>} />
    <div className="metrics">
      <MetricCard label="当前余额" value={formatCredits(overview.data?.balance || 0)} hint="机构共享魔法石池" />
      <MetricCard label="累计充值" value={formatCredits(overview.data?.totalCreditsIn || 0)} hint={`实收金额 ¥${((overview.data?.paidTotalFen || 0) / 100).toFixed(2)}`} tone="teal" />
      <MetricCard label="累计消耗" value={formatCredits(overview.data?.totalCreditsSpent || 0)} hint="按成功调用扣减" tone="orange" />
      <MetricCard label="充值订单" value={`${overview.data?.paidOrderCount || 0}/${overview.data?.orders?.length || 0}`} hint={`已支付 / 全部订单，待处理 ${overview.data?.pendingOrderCount || 0}`} tone="pink" />
    </div>
    <div className="split">
      <Panel title="充值订单"><table><thead><tr><th>订单号</th><th>金额</th><th>魔法石</th><th>状态</th><th>创建时间</th></tr></thead><tbody>{(overview.data?.orders || []).map((item) => <tr key={item.id}><td>{item.orderNo}</td><td>¥{(item.amountFen / 100).toFixed(2)}</td><td>{formatCredits(item.credits)}{item.bonusCredits ? <div className="muted">赠 {formatCredits(item.bonusCredits)}</div> : null}</td><td><Status value={item.status} /></td><td>{formatDate(item.createdAt)}</td></tr>)}</tbody></table></Panel>
      <Panel title="积分流水"><table><thead><tr><th>时间</th><th>类型</th><th>方向 / 积分</th><th>余额</th><th>状态</th></tr></thead><tbody>{(overview.data?.entries || []).map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}</td><td>{item.type}<div className="muted">{item.reason || item.modality || '—'}</div></td><td>{item.direction === 'IN' ? '+' : '-'}{formatCredits(item.credits)}</td><td>{formatCredits(item.balanceAfter)}</td><td><Status value={item.status} /></td></tr>)}</tbody></table></Panel>
    </div>
    <Panel title="支付接入说明"><Notice tone="info">当前页面只读取真实充值单与积分流水，不提供模拟支付或伪造支付成功状态。</Notice></Panel>
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
  return <AppShell product="AI 魔法学院" roleLabel={session.user.role === 'TEACHER' ? '授课教师' : '机构管理员'} user={session.user} navigation={navigation} onLogout={logout}><Routes><Route path="/dashboard" element={<Dashboard api={api} />} /><Route path="/classes" element={<Classes api={api} user={session.user} />} /><Route path="/members" element={<Members api={api} />} /><Route path="/works" element={<Works api={api} />} /><Route path="/inbox" element={<OrgPage kind="inbox" user={session.user} />} /><Route path="/courses" element={<OrgCourses api={api} />} /><Route path="/work-data" element={<OrgPage kind="work-data" user={session.user} />} /><Route path="/packages" element={<BillingPackages api={api} user={session.user} />} /><Route path="/enrollment" element={<OrgPage kind="enrollment" user={session.user} />} /><Route path="/recharge" element={<BillingAccountPage api={api} user={session.user} />} /><Route path="/usage" element={<UsagePage api={api} />} /><Route path="/materials" element={<OrgPage kind="materials" user={session.user} />} /><Route path="/hackathon" element={<OrgPage kind="hackathon" user={session.user} />} /><Route path="/afee" element={<OrgPage kind="afee" user={session.user} />} /><Route path="*" element={<Navigate to="/dashboard" replace />} /></Routes></AppShell>;
}
createRoot(document.getElementById('root')).render(<BrowserRouter><App /></BrowserRouter>);
