// 机构端 - 课堂（2026-09-13，批次 B-6）
//
// 一句话：**班级彻底退场，课堂成为主对象**。这一页就是老师/机构管理员的工作台：
//   开课（选课包 + 第几节课）→ 加学员（可加 / 不可加两栏）→ 开始上课 → 结束或解散。
//
// 与相邻页面的边界：
//   · 本页＝开课与上课本身（名单、状态、课件入口）
//   · 「课包概览」＝课包的分配与使用账（次数、学员、课堂数）
//   · 「学员许可」＝把课包分给学员（**没有许可的人加不进课堂**，本页会如实说原因）
//   · 「模型与算力」＝单价与上限；本页不重复那些口径
//
// 几条容易搞混的口径（都按用户确认过的写法落在这页上）：
//   ① 有许可 ≠ 能进操作环境：许可只代表能看课包信息，**必须被老师加进课堂**才能上课。
//   ② 一个学生在一节课上只能属于一个未结束的课堂 —— 不可加名单会写出「占用它的是哪个课堂」。
//   ③ 移除学员**只在开始上课前**；移除＝解锁（可以被别的课堂再添加）。
//   ④ 完课判定＝这个学生在这节课消耗过算力（真实成功调用，不依赖金额），结束课堂时自动结算。
//   ⑤ 课堂自带入口类型：画布课堂 / VibeCoding 课堂，一个课堂只有一种。
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Empty, ErrorState, Loading, MetricCard, Notice, PageHeader, Panel, SearchSelect, formatDate, formatYuan, useData } from '@platform/shared';

const SESSION_STATE = {
  PENDING: { label: '待上课', tone: 'warning' },
  ACTIVE: { label: '上课中', tone: 'success' },
  ENDED: { label: '已结束', tone: 'muted' },
  DISSOLVED: { label: '已解散', tone: 'danger' },
};
const STUDENT_STATE = {
  PENDING: { label: '待上课', tone: 'warning' },
  ACTIVE: { label: '上课中', tone: 'success' },
  COMPLETED: { label: '已完课', tone: 'success' },
  INCOMPLETE: { label: '未完课', tone: 'danger' },
  REMOVED: { label: '被移除', tone: 'muted' },
};
const DELIVERY_LABEL = { CANVAS: '画布课堂', VIBECODING: 'VibeCoding 课堂' };

// 状态徽标：用共享设计系统的 .status 样式，但文案走中文（后端已经给了 statusLabel，
// 这里再留一份是为了在标签缺失时也有话说）。
function StateBadge({ value, map }) {
  const item = map[value] || { label: value || '未知状态', tone: 'muted' };
  return <span className={'status ' + (item.tone === 'muted' ? '' : item.tone)}>{item.label}</span>;
}

function Modal({ title, description, children, onClose, footer }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.showModal();
    return () => { ref.current?.close(); previous?.focus?.(); };
  }, []);
  return <dialog ref={ref} className="classroom-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose(); }} style={{ width: 'min(620px, 92vw)', maxHeight: '88vh', overflow: 'auto', border: '1px solid #d7dfeb', borderRadius: 16, padding: 28 }}>
      <h3 id={titleId}>{title}</h3>
      {description ? <p className="muted">{description}</p> : null}
      {children}
      <div className="row-actions top-gap">{footer}</div>
  </dialog>;
}

export function Classrooms({ api, user }) {
  const isAdmin = user.role === 'ORG_ADMIN';
  const navigate = useNavigate();
  const { sessionId = '' } = useParams();
  const openId = sessionId;
  const [status, setStatus] = useState('');
  const [days, setDays] = useState('90');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 确认弹窗：{ kind: 'start'|'end'|'dissolve', session }
  const [confirm, setConfirm] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ seriesId: '', lessonId: '', title: '', teacherId: '', deliveryMode: 'CANVAS' });
  const [picked, setPicked] = useState([]);

  const query = new URLSearchParams();
  if (status) query.set('status', status);
  query.set('days', days);
  const list = useData(() => api.get('org/sessions?' + query.toString()), [api, status, days]);
  const sessions = list.data?.items || [];
  const ongoingSession = !isAdmin ? list.data?.ongoingSession : null;

  // 详情与候选人都挂在选中的课堂上；用 list.data 做依赖，列表刷新后详情跟着刷新
  const detail = useData(
    () => (openId ? api.get('org/sessions/' + encodeURIComponent(openId)) : Promise.resolve(null)),
    [api, openId, list.data],
  );
  const candidates = useData(
    () => (openId ? api.get('org/sessions/' + encodeURIComponent(openId) + '/candidates') : Promise.resolve(null)),
    [api, openId, list.data],
  );
  // 建课堂要用的课包（含课时）：机构端课包接口一次就把 lessons 带回来了
  const series = useData(() => api.get('org/course-series?limit=200'), [api]);
  const seriesItems = series.data?.items || [];
  // 机构管理员可以把课堂挂到别的老师名下；教师建课只能挂自己（服务端也这么判）
  const teachers = useData(() => (isAdmin ? api.get('org/users?role=TEACHER') : Promise.resolve({ items: [] })), [api, isAdmin]);
  const teacherItems = teachers.data?.items || [];
  const currentSeries = seriesItems.find((item) => item.id === form.seriesId) || null;
  const lessonOptions = (currentSeries?.lessons || []).filter((item) => item.status === 'PUBLISHED');
  const selectedLesson = lessonOptions.find((lesson) => lesson.id === form.lessonId) || null;
  const lessonModes = selectedLesson?.deliveryModes || [];
  const current = detail.data || sessions.find((item) => item.id === openId) || null;
  const summary = detail.data?.studentSummary || {};
  const selectable = candidates.data?.selectable || [];
  const blocked = candidates.data?.blocked || [];
  const alreadyIn = candidates.data?.alreadyIn || [];
  // 名单为空时不能开课（服务端也拒：SESSION_STUDENTS_REQUIRED）—— 按钮置灰，并把原因写在旁边
  const canStart = current?.status === 'PENDING' && Number(summary.pending || 0) > 0;
  const roster = detail.data?.students || [];

  const totals = {
    pending: sessions.filter((item) => item.status === 'PENDING').length,
    active: sessions.filter((item) => item.status === 'ACTIVE').length,
    ended: sessions.filter((item) => item.status === 'ENDED').length,
    dissolved: sessions.filter((item) => item.status === 'DISSOLVED').length,
  };

  function openSession(id) {
    navigate('/classrooms/' + encodeURIComponent(id), { state: { fromClassroomList: true } });
    setPicked([]);
    setMessage('');
    setError('');
  }

  function closeSession() {
    if (window.history.state?.usr?.fromClassroomList) navigate(-1);
    else navigate('/classrooms', { replace: true });
  }

  async function run(action, fallback = '操作完成。') {
    setBusy(true); setError(''); setMessage('');
    try { await action(); setMessage(fallback); await list.refresh(); if (openId) { await detail.refresh(); await candidates.refresh(); } }
    catch (err) { setError(err.message || '操作失败'); }
    finally { setBusy(false); }
  }

  async function createSession() {
    await run(async () => {
      const created = await api.post('org/sessions', {
        lessonId: form.lessonId,
        title: form.title || undefined,
        deliveryMode: form.deliveryMode,
        ...(isAdmin && form.teacherId ? { teacherId: form.teacherId } : {}),
      });
      setCreateOpen(false);
      setForm({ seriesId: '', lessonId: '', title: '', teacherId: '', deliveryMode: 'CANVAS' });
      openSession(created?.id || '');
    }, '课堂已创建（待上课）。接下来加学员，然后点「开始上课」。');
  }

  async function addStudents() {
    if (!picked.length) { setError('请先勾选要加入的学员。'); return; }
    await run(async () => {
      const result = await api.post(`org/sessions/${encodeURIComponent(openId)}/students`, { studentIds: picked });
      setPicked([]);
      const skipped = result?.skipped?.length || 0;
      setMessage(skipped ? `已加入 ${result?.added?.length || 0} 人，跳过 ${skipped} 人（状态在你看的这会儿变了）。` : `已加入 ${result?.added?.length || 0} 名学员。`);
    });
  }

  const removeStudent = (student) => run(
    () => api.delete(`org/sessions/${encodeURIComponent(openId)}/students/${encodeURIComponent(student.studentId)}`),
    `已把 ${student.studentName || student.studentLogin} 移出课堂。ta 现在可以被别的课堂添加。`,
  );

  const actAndClose = (kind) => run(async () => {
    await api.post(`org/sessions/${encodeURIComponent(openId)}/${kind}`);
    setConfirm(null);
  }, kind === 'start' ? '课堂已开始，学员现在可以进操作环境了。' : kind === 'end' ? '课堂已结束，学员按「这节课有没有消耗过算力」结算成已完课 / 未完课。' : '课堂已解散，名单上的学员全部置为「被移除」。');

  return <>
    <PageHeader
      eyebrow="开课与上课"
      title="课堂"
      description="创建课堂（选课包与第几节课）→ 添加学员 → 开始上课 → 结束或解散。学员必须是「有课包许可 + 被加进课堂」才能进操作环境。"
      actions={<>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="按状态筛选">
          <option value="">全部状态</option>
          <option value="PENDING">待上课</option><option value="ACTIVE">上课中</option>
          <option value="ENDED">已结束</option><option value="DISSOLVED">已解散</option>
        </select>
        <button className="secondary-button" onClick={list.refresh}>刷新</button>
        <button className="primary-button" disabled={busy || list.loading || Boolean(ongoingSession)} title={ongoingSession ? '请先结束或解散当前课堂' : ''} onClick={() => { setCreateOpen(true); setMessage(''); setError(''); }}>创建课堂</button>
      </>}
    />

    {ongoingSession ? <Notice tone="info">当前课堂：<strong>{ongoingSession.title}</strong> · {SESSION_STATE[ongoingSession.status]?.label}。结束或解散后可创建下一场。<button className="text-button" onClick={() => openSession(ongoingSession.id)}>管理当前课堂</button></Notice> : null}
    {message ? <Notice tone="success">{message}</Notice> : null}
    {error ? <Notice tone="danger">{error}</Notice> : null}

    {!openId ? <div className="metrics">
      <MetricCard label="待上课" value={totals.pending} hint="还没开始，可以加/移除学员" tone="orange" />
      <MetricCard label="上课中" value={totals.active} hint="学员现在能进操作环境" tone="teal" />
      <MetricCard label="已结束" value={totals.ended} hint={`近 ${days} 天内`} />
      <MetricCard label="已解散" value={totals.dissolved} hint={`近 ${days} 天内`} tone="pink" />
    </div> : null}

    {!openId ? <Panel title={`课堂列表（近 ${days} 天）`} actions={
      <select value={days} onChange={(event) => setDays(event.target.value)} aria-label="时间范围">
        <option value="7">近 7 天</option><option value="30">近 30 天</option>
        <option value="90">近 90 天</option><option value="365">近 365 天</option>
      </select>
    }>
      {list.loading ? <Loading label="正在读取课堂…" /> : list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : sessions.length ? <div className="table-wrap"><table>
        <thead><tr><th>课堂</th><th>课包 / 课时</th><th>老师</th><th>状态</th><th>学员</th><th>时间</th><th /></tr></thead>
        <tbody>{sessions.map((item) => <tr key={item.id}>
          <td><strong>{item.title || '未命名课堂'}</strong><div className="muted">{DELIVERY_LABEL[item.deliveryMode] || item.deliveryMode}</div></td>
          <td>{item.seriesTitle || '—'}<div className="muted">{item.lessonTitle || '—'}{item.lessonSort ? ` · 第 ${item.lessonSort} 节` : ''}</div></td>
          <td>{item.teacherName || '—'}</td>
          <td><StateBadge value={item.status} map={SESSION_STATE} /></td>
          <td>{item.studentCount ?? 0}<div className="muted">完课 {item.completedCount ?? 0}</div></td>
          <td className="muted">{formatDate(item.startedAt || item.createdAt)}</td>
          <td><button type="button" className="text-button" onClick={() => openSession(item.id)}>管理</button></td>
        </tr>)}</tbody>
      </table></div> : <Empty title="还没有课堂" body="点右上角「创建课堂」：选课包、选第几节课，然后添加学员。" />}
    </Panel> : null}

    {openId ? <Panel title={`${current?.title || '课堂'} · 名单与操作`} actions={
      <div className="row-actions">
        {current?.coursewareUrl ? <a className="secondary-button" href={current.coursewareUrl} target="_blank" rel="noreferrer">查看课件</a> : null}
        {current?.status === 'PENDING' ? <>
          <button className="primary-button" disabled={busy || !canStart} title={canStart ? '' : '先添加学员再开始上课（名单为空不能开课）'} onClick={() => setConfirm({ kind: 'start' })}>开始上课</button>
          <button className="secondary-button" disabled={busy} onClick={() => setConfirm({ kind: 'dissolve' })}>解散课堂</button>
        </> : null}
        {current?.status === 'ACTIVE' ? <button className="primary-button" disabled={busy} onClick={() => setConfirm({ kind: 'end' })}>结束课堂</button> : null}
        <button className="secondary-button" onClick={closeSession}>返回课堂列表</button>
      </div>
    }>
      {detail.loading ? <Loading label="正在读取课堂详情…" /> : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : <>
        <div className="row-actions">
          <StateBadge value={current?.status} map={SESSION_STATE} />
          <span className="muted">{DELIVERY_LABEL[current?.deliveryMode] || current?.deliveryMode}</span>
          <span className="muted">{current?.seriesTitle || '—'} · {current?.lessonTitle || '—'}</span>
          <span className="muted">负责老师：{current?.teacherName || '—'}</span>
        </div>
        {current?.status === 'PENDING' && !canStart ? <Notice tone="warning">名单还是空的：<strong>先添加学员再开始上课</strong>。「开始上课」按钮在名单为空时是灰的，服务端也会拒（名单为空不能开课）。</Notice> : null}
        {current?.status === 'ACTIVE' ? <Notice tone="info">课堂进行中：学员现在能进操作环境。<strong>移除学员只在开始上课前</strong>可用（开始后就不动了，免得把已经创作到一半的人踢掉）。</Notice> : null}
        {current?.status === 'ENDED' ? <Notice tone="info">课堂已结束。完课判定＝这个学生在这节课<strong>消耗过算力</strong>（真实成功调用，费用为零或尚未确定也计入）；没有成功调用的算未完课。在途调用成功后会补记完课。</Notice> : null}
        {current?.status === 'DISSOLVED' ? <Notice tone="warning">课堂已解散，名单上的学员都已置为「被移除」（= 解锁，可以被别的课堂再添加）。</Notice> : null}

        <nav aria-label="课堂步骤" className="row-actions top-gap">
          <span className="status success">1 · 课堂已创建</span>
          <span className={'status ' + (summary.total ? 'success' : 'warning')}>2 · 添加学员</span>
          <span className={'status ' + (current?.status === 'ACTIVE' ? 'success' : '')}>3 · 开始上课</span>
          <span className={'status ' + (current?.status === 'ENDED' ? 'success' : '')}>4 · 结束课堂</span>
        </nav>
        {current?.status === 'PENDING' ? <p className="muted">{summary.total ? '名单已就绪，确认学员后点击「开始上课」。' : '下一步：在下方可添加名单勾选学员，点击「加入课堂」。'}</p> : null}
        <h3>名单（{summary.total ?? 0} 人 · 完课 {summary.completed ?? 0} · 未完课 {summary.incomplete ?? 0} · 被移除 {summary.removed ?? 0}）</h3>
        {roster.length ? <div className="table-wrap"><table>
          <thead><tr><th>学员</th><th>账号</th><th>状态</th><th>这节课消耗</th><th>加入</th><th /></tr></thead>
          <tbody>{roster.map((student) => <tr key={student.id}>
            <td><strong>{student.studentName || student.studentLogin}</strong></td>
            <td className="muted">{student.studentLogin}</td>
            <td><StateBadge value={student.status} map={STUDENT_STATE} />
              {student.status === 'REMOVED' && student.removedReason ? <div className="muted">{student.removedReason}</div> : null}
              {student.completedAt ? <div className="muted">结算于 {formatDate(student.completedAt)}</div> : null}
            </td>
            <td>{student.status === 'COMPLETED' || student.status === 'INCOMPLETE' ? formatYuan(student.completedCostFen) : <span className="muted">—</span>}</td>
            <td className="muted">{formatDate(student.addedAt)}{student.addedByName ? ` · ${student.addedByName}` : ''}</td>
            <td>{current?.status === 'PENDING' && student.status !== 'REMOVED'
              ? <button type="button" className="text-button" disabled={busy} onClick={() => removeStudent(student)}>移除</button>
              : <span className="muted">{student.status === 'REMOVED' ? '已移除' : '开始后不可移除'}</span>}</td>
          </tr>)}</tbody>
        </table></div> : <Empty title="名单还是空的" body="用下面的「可加」栏勾选学员加入课堂。" />}

        {current?.status === 'PENDING' || current?.status === 'ACTIVE' ? <>
          <h3 className="top-gap">添加学员</h3>
          <p className="muted">「可加」＝有本课包许可、且这节课上还没有被别的未结束课堂占着。「不可加」都写明了原因；被别的课堂占着的会标出是哪个课堂。</p>
          <div className="split">
            <Panel title={`可加（${selectable.length}）`} actions={selectable.length ? <button type="button" className="text-button" onClick={() => setPicked(picked.length === selectable.length ? [] : selectable.map((item) => item.id))}>{picked.length === selectable.length ? '全不选' : '全选'}</button> : null}>
              {candidates.loading ? <Loading label="正在读取候选人…" /> : candidates.error ? <ErrorState error={candidates.error} onRetry={candidates.refresh} /> : selectable.length ? <div className="card-list">{selectable.map((student) => <label key={student.id} className="item-card">
                <span className="row-actions">
                  <input type="checkbox" style={{ width: 'auto' }} checked={picked.includes(student.id)} onChange={(event) => setPicked((old) => event.target.checked ? [...old, student.id] : old.filter((id) => id !== student.id))} />
                  <strong>{student.name || student.login}</strong>
                  <span className="muted">{student.login}{student.accountStatus !== 'ACTIVE' ? ` · 账号${student.accountStatus}` : ''}</span>
                </span>
              </label>)}</div> : <Empty title="没有可加的学员" body="要么本机构学员都已经在这节课上了，要么都还没有这个课包的许可 —— 先到「学员许可」把课包分给 ta。" />}
              <div className="row-actions top-gap">
                <button className="primary-button" disabled={busy || !picked.length} onClick={addStudents}>加入课堂（已选 {picked.length} 人）</button>
              </div>
            </Panel>
            <Panel title={`不可加（${blocked.length}）`}>
              {blocked.length ? <div className="card-list">{blocked.map((student) => <div key={student.id} className="item-card">
                <h3>{student.name || student.login}</h3>
                <p className="muted">{student.login}</p>
                <p>{student.reasonText || '不可加入'}</p>
                {student.session?.title ? <small className="muted">占用它的课堂：{student.session.title} · {SESSION_STATE[student.session.status]?.label || student.session.status} · {student.session.teacherName || '未知老师'}</small> : null}
              </div>)}</div> : <p className="muted">当前没有被挡住的学员。</p>}
              {alreadyIn.length ? <p className="muted top-gap">另外 {alreadyIn.length} 人已经在这节课上：{alreadyIn.map((item) => item.name || item.login).join('、')}</p> : null}
            </Panel>
          </div>
        </> : null}
      </>}
    </Panel> : null}

    {createOpen ? <Modal
      title="创建课堂"
      description="选课包 → 选第几节课。创建后是「待上课」，加完学员再点「开始上课」。"
      onClose={() => { if (!busy) setCreateOpen(false); }}
      footer={<>
        <button className="secondary-button" disabled={busy} onClick={() => setCreateOpen(false)}>取消</button>
        <button className="primary-button" disabled={busy || !form.lessonId} onClick={createSession}>创建课堂</button>
      </>}
    >
      <label>课包<SearchSelect ariaLabel="搜索课包" value={form.seriesId} options={seriesItems} placeholder="请选择课包" getLabel={(item) => item.title} onChange={(seriesId) => setForm({ ...form, seriesId, lessonId: '', deliveryMode: 'CANVAS' })} /></label>
      {series.loading ? <p className="muted">正在读取可授权的课包…</p> : null}
      {!series.loading && !seriesItems.length ? <Notice tone="warning">本机构还没有被授权任何课包：先让平台把课包授权给本机构（见「课程中心」）。</Notice> : null}
      <label>第几节课<select value={form.lessonId} onChange={(event) => {
        const lesson = lessonOptions.find((item) => item.id === event.target.value);
        setForm({ ...form, lessonId: event.target.value, deliveryMode: lesson?.deliveryMode || 'CANVAS' });
      }} disabled={!form.seriesId}>
        <option value="">{form.seriesId ? '请选择课时' : '先选课包'}</option>
        {lessonOptions.map((lesson) => <option key={lesson.id} value={lesson.id}>第 {lesson.sort} 节 · {lesson.title}</option>)}
      </select></label>
      {form.seriesId && !series.loading && !lessonOptions.length ? <Notice tone="warning">这个课包还没有已发布的课时，不能开课。</Notice> : null}
      {lessonModes.length > 1 ? <div className="card-list">{lessonModes.map((mode) => <button type="button" key={mode} className={form.deliveryMode === mode ? 'item-card selected' : 'item-card'} onClick={() => setForm({ ...form, deliveryMode: mode })}><strong>{DELIVERY_LABEL[mode]}</strong><span className="muted">按已批准方案提供的工作区</span></button>)}</div> : null}
      {lessonModes.length > 1 ? <p className="muted">已选工作区：{DELIVERY_LABEL[form.deliveryMode] || form.deliveryMode}</p> : null}
      {isAdmin ? <label>负责老师<SearchSelect ariaLabel="搜索负责老师" value={form.teacherId} options={teacherItems} placeholder="挂在我自己名下" getLabel={(item) => item.displayName || item.login} onChange={(teacherId) => setForm({ ...form, teacherId })} /></label> : null}
      <label>课堂名称（可留空）<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="留空就自动取「课时名 · 日期」" /></label>
      {!isAdmin ? <p className="muted">教师同一时刻只能有一个待上课或上课中的课堂；请先结束或解散当前课堂再创建。</p> : <p className="muted">你是机构管理员，可以看到并管理本机构的全部课堂。</p>}
    </Modal> : null}

    {confirm ? <Modal
      title={confirm.kind === 'start' ? '确认开始上课？' : confirm.kind === 'end' ? '确认结束课堂？' : '确认解散课堂？'}
      description={confirm.kind === 'start'
        ? `开始后名单上的 ${summary.pending ?? 0} 名学员立刻可以进操作环境。开始之后就不能再移除学员了。`
        : confirm.kind === 'end'
          ? '结束时会按「这节课有没有消耗过算力」给每个学员结算成已完课 / 未完课，在途调用成功后会补记完课，不必重复提交。'
          : '解散只适用于还没开始的课堂：名单上的学员会全部置为「被移除」（= 解锁，可以被别的课堂再添加）。'}
      onClose={() => { if (!busy) setConfirm(null); }}
      footer={<>
        <button className="secondary-button" onClick={() => setConfirm(null)}>取消</button>
        <button className={confirm.kind === 'dissolve' ? 'secondary-button' : 'primary-button'} disabled={busy} onClick={() => actAndClose(confirm.kind)}>
          {busy ? '处理中…' : confirm.kind === 'start' ? '确认开始' : confirm.kind === 'end' ? '确认结束' : '确认解散'}
        </button>
      </>}
    >
      <div className="row-actions">
        <StateBadge value={current?.status} map={SESSION_STATE} />
        <span className="muted">{current?.title} · {current?.lessonTitle || '—'}</span>
      </div>
    </Modal> : null}
  </>;
}
