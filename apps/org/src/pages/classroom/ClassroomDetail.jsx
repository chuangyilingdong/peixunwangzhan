// 005-03 课堂详情（2026-09-17 按线框图重做）。
//
// 结构按线框图分成「左：课堂信息 / 右：课堂操作」两栏，下面是学生名单。
// 四个二次确认弹窗（编辑名称 / 移除学生 / 开始上课 / 解散课堂）
// 都改成「信息带 + 影响说明 + 逐条校验」的样子 —— 其中校验清单来自服务端预检接口，
// 界面上不做任何推断（推不出来的条目宁可不显示，也不能凭空打勾）。
//
// ⚠️ 2026-09-20 用户口径：原先那两块说明面板（「XX 阶段可操作」「页面边界」）与课堂/学生的
//    「AI 使用 · 算力观测 · 最近活动」那几行**已整块删除**（连同 STAGE_NOTES / capText / AiUsage）。
//    那些是内部观测与文档式口径，不是老师要看的东西 —— 别再照线框图加回来。
//    ⚠️ 名单里的「最近活动」**列**保留了（那只是活动时间；这次删的是课堂操作里那行汇总文案）。
import { useEffect, useRef, useState } from 'react';
import { Empty, ErrorState, formatDate, Loading, Notice, PageHeader, Panel, useData } from '@platform/shared';
import { Checklist, DefinitionGrid, InfoStrip, Modal, RenameWorkDialog } from './ui.jsx';
import { ClassroomWork } from './ClassroomWork.jsx';
import { DELIVERY_LABEL, removedReasonLabel, SESSION_STATE, StateBadge, STUDENT_STATE } from './states.jsx';

function Duration({ runtime, status }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (status !== 'ACTIVE') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status, runtime]);
  const started = Date.parse(runtime?.startedAt);
  const ended = Date.parse(runtime?.endedAt);
  const snapshot = Date.parse(runtime?.asOf);
  let seconds = Number.isFinite(started) && (status === 'ACTIVE' || Number.isFinite(ended))
    ? Math.max(0, Math.floor(((status === 'ACTIVE' ? now : ended) - started) / 1000)) : null;
  if (Number.isFinite(runtime?.durationSeconds)) {
    seconds = Math.max(0, Math.floor(runtime.durationSeconds + (status === 'ACTIVE' && Number.isFinite(snapshot) ? Math.max(0, now - snapshot) / 1000 : 0)));
  }
  return <span>{seconds === null ? '尚未开始' : `${Math.floor(seconds / 3600)} 时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒`}</span>;
}

export function ClassroomDetail({ api, openId, onBack, onAddStudents }) {
  const detail = useData(() => openId ? api.get('org/sessions/' + encodeURIComponent(openId)) : Promise.resolve(null), [api, openId]);
  // 绝不用列表或上一个路由的响应来授权详情操作。
  const current = !detail.loading && !detail.error && detail.data?.id === openId ? detail.data : null;
  const permissions = current?.permissions || {};
  const canManage = permissions.canManage === true;
  const allowed = (key) => canManage && permissions[key] === true;
  const summary = current?.studentSummary || {};
  const roster = current?.students || [];
  const terminal = ['ENDED', 'DISSOLVED'].includes(current?.status);
  const canAdd = allowed('canAddStudents') && ['PENDING', 'ACTIVE'].includes(current?.status);

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [modal, setModal] = useState(null);
  const [titleDraft, setTitleDraft] = useState('');

  const precheckAction = modal?.kind === 'start' ? 'start' : modal?.kind === 'dissolve' ? 'dissolve' : null;
  const precheck = useData(() => precheckAction && openId
    ? api.get(`org/sessions/${encodeURIComponent(openId)}/precheck?action=${precheckAction}`) : Promise.resolve(null), [api, openId, precheckAction]);
  const checks = precheck.data?.checks || [];
  const checksReady = precheckAction && !precheck.loading && !precheck.error && precheck.data?.action === precheckAction;
  // 预检不是放行凭据：状态可能在打开弹窗之后被改掉，所以按钮只在「真的全通过」时才可点，
  // 而不通过时给出原因；真正的把关仍在服务端那几个断言里。
  const startBlocked = modal?.kind === 'start' && (!checksReady || !checks.every((item) => item.passed));
  const dissolveBlocked = modal?.kind === 'dissolve' && (!checksReady || !checks.every((item) => item.passed));

  useEffect(() => { setModal(null); setError(''); setMessage(''); }, [openId]);

  async function run(action, fallback, permission) {
    if (busyRef.current) return;
    if (permission && !allowed(permission)) { setError('课堂详情未就绪或当前操作无权限，请刷新后重试。'); return; }
    busyRef.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const feedback = await action();
      setMessage(typeof feedback === 'string' ? feedback : fallback);
      await detail.refresh();
    } catch (err) {
      setError(err.message || '操作失败，请重试。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const titleValidation = !titleDraft.trim() ? '课堂名称不能为空。'
    : titleDraft.trim() === current?.title?.trim() ? '名称没有变化。'
      : titleDraft.trim().length > 50 ? '课堂名称不能超过 50 个字符。' : '';

  function showModal(value) { setError(''); setModal(value); }
  function closeModal() { if (!busyRef.current) { setModal(null); setError(''); } }

  async function saveTitle() {
    if (titleValidation) { setError(titleValidation); return; }
    await run(async () => {
      await api.put(`org/sessions/${encodeURIComponent(openId)}`, { title: titleDraft.trim() });
      setModal(null);
    }, '课堂名称已更新。', 'canEdit');
  }
  async function actAndClose() {
    const kind = modal?.kind;
    const permission = { remove: 'canRemoveStudents', start: 'canStart', end: 'canEnd', dissolve: 'canDissolve' }[kind];
    if (!permission) return;
    await run(async () => {
      if (kind === 'remove') {
        if (current?.status !== 'PENDING' || !modal.student?.studentId) throw new Error('当前不能移除该学生，请刷新名单。');
        await api.delete(`org/sessions/${encodeURIComponent(openId)}/students/${encodeURIComponent(modal.student.studentId)}`);
      } else {
        await api.post(`org/sessions/${encodeURIComponent(openId)}/${kind}`);
      }
      setModal(null);
    }, { remove: '学生已移除，可以被其他课堂添加。', start: '课堂已开始。', end: '课堂已结束，完课结果已结算。', dissolve: '课堂已解散，学生已解除占用。' }[kind], permission);
  }

  const courseLine = current ? `${current.seriesTitle || '—'}${current.lessonTitle ? ` · ${current.lessonTitle}` : ''}` : '—';

  return <div className="classrooms-page">
    <PageHeader eyebrow="开课与上课" title="课堂详情"
      actions={<button className="secondary-button" disabled={busy} onClick={onBack}>← 返回列表</button>} />

    {message ? <div role="status"><Notice tone="success">{message}</Notice></div> : null}
    {error && !modal ? <div role="alert"><Notice tone="danger">{error}</Notice></div> : null}

    {detail.loading || (!detail.error && !current) ? <Loading label="正在读取课堂详情…" />
      : detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} />
        : current ? <>
          {current.status === 'PENDING' ? <Notice tone="info">
            <strong>待上课：</strong>课堂已创建但尚未开始。当前可维护学生名单、查看课程资料、开始上课或解散课堂。
            <div className="muted">
              当前已有 {summary.total ?? 0} 名学生，因此课包 / 课程已锁定；系统不会自动清空学生名单。
              {/* 线框图这里写的是「如需更换，必须先移除全部学生」—— 但本轮**没有**做更换入口
                  （2026-09-17 决定不做：后端支持，代价是把名单全部置为已移除）。
                  照抄那句话会让老师到处找一个不存在的按钮，所以只说明锁定状态。 */}
              如需改课，请解散后重新创建。
            </div>
          </Notice> : null}
          {current.status === 'ACTIVE' ? <Notice tone="success">课堂进行中：仍可添加符合条件的新学生，但开始后不可移除学生。</Notice> : null}
          {terminal ? <Notice tone="info">{current.status === 'ENDED'
            ? '课堂已结束，完课结果固定。'
            : '课堂已解散，学生占用已解除。'}</Notice> : null}

          <div className="classroom-detail-grid">
            <Panel title="课堂信息">
              <DefinitionGrid columns={2} items={[
                { label: '课堂名称', value: current.title || '未命名课堂' },
                { label: '负责老师', value: current.teacherName || '—' },
                { label: '学生数', value: `${summary.total ?? 0} 人` },
                { label: '上课类型', value: DELIVERY_LABEL[current.deliveryMode] || current.deliveryMode || '—' },
                // 线框图这里还有一行「创建账号」——class_sessions 没有 created_by 列，
                // 谁都读不出来，所以只显示负责老师，不编一个名字上去。
                { label: '课包', value: current.seriesTitle || '—', badge: current.status === 'PENDING' ? '已锁定' : null },
                { label: '课程', value: current.lessonTitle || '—', note: current.lessonSort ? `第 ${current.lessonSort} 节` : null, badge: current.status === 'PENDING' ? '已锁定' : null },
                { label: '创建时间', value: formatDate(current.createdAt) },
                { label: '实际开始', value: formatDate(current.startedAt) },
                { label: '实际结束', value: formatDate(current.endedAt) },
                { label: '课堂时长', value: <Duration runtime={current.runtime || { startedAt: current.startedAt, endedAt: current.endedAt }} status={current.status} /> },
              ]} />
            </Panel>

            <Panel title="课堂操作">
              <div className="classroom-actions-stack">
                {current.status === 'PENDING' && allowed('canEdit')
                  ? <button className="secondary-button" disabled={busy} onClick={() => { setTitleDraft(current.title || ''); showModal({ kind: 'title' }); }}>编辑课堂名称</button>
                  : <button className="secondary-button" disabled>编辑课堂名称</button>}
                {current.coursewareUrl
                  ? <a className="secondary-button" href={current.coursewareUrl} target="_blank" rel="noreferrer">查看课程资料</a>
                  : <button className="secondary-button" disabled>查看课程资料</button>}
                {allowed('canStart') && current.status === 'PENDING'
                  ? <button className="primary-button" disabled={busy || !summary.pending} onClick={() => showModal({ kind: 'start' })}>开始上课</button>
                  : null}
                {allowed('canEnd') && current.status === 'ACTIVE'
                  ? <button className="primary-button" disabled={busy} onClick={() => showModal({ kind: 'end' })}>结束课堂</button>
                  : null}
                {allowed('canDissolve') && current.status === 'PENDING'
                  ? <button className="secondary-button danger-outline" disabled={busy} onClick={() => showModal({ kind: 'dissolve' })}>解散课堂</button>
                  : null}
              </div>
              {current.status === 'PENDING' && !summary.pending ? <p className="muted">名单为空：添加学生后才能开始上课。</p> : null}
            </Panel>
          </div>

          <Panel title={`学生名单（当前 ${summary.total ?? 0} 人）`}
            actions={canAdd ? <button className="primary-button" disabled={busy} onClick={onAddStudents}>添加学生</button> : null}>
            <p className="muted">完课 {summary.completed ?? 0} · 未完课 {summary.incomplete ?? 0} · 已移除 {summary.removed ?? 0}</p>
            {roster.length ? <div className="table-wrap"><table>
              <thead><tr>
                <th>序号</th><th>学生</th><th>登录账号</th><th>加入课堂时间</th><th>状态 / 完课结果</th>
                <th>最近活动</th><th>作品</th><th>操作</th>
              </tr></thead>
              <tbody>{roster.map((student, index) => <tr key={student.id}>
                <td>{index + 1}</td>
                <td><strong>{student.studentName || student.studentLogin}</strong></td>
                <td className="muted">{student.studentLogin || '—'}</td>
                <td>{formatDate(student.addedAt)}</td>
                <td><StateBadge value={student.status} map={STUDENT_STATE} />
                  {student.removedReason ? <div className="muted">{removedReasonLabel(student.removedReason)}</div> : null}
                  {student.completedAt ? <div className="muted">完课于 {formatDate(student.completedAt)}</div> : null}</td>
                <td>{student.lastActivityAt ? formatDate(student.lastActivityAt) : '暂无活动记录'}</td>
                <td>{student.workCount ?? '—'}</td>
                <td>{allowed('canRemoveStudents') && current.status === 'PENDING' && student.status !== 'REMOVED'
                  ? <button className="text-button danger-text" disabled={busy} onClick={() => showModal({ kind: 'remove', student })}>移除</button>
                  : <span className="muted">只读</span>}</td>
              </tr>)}</tbody>
            </table></div> : <Empty title="暂无学生" body={canAdd ? '点右上角「添加学生」把学生加进这堂课。' : '此课堂没有学生记录。'} />}
          </Panel>

          <Panel title={`课堂作品（${current.works?.length ?? 0}）`}>
            {current.works?.length ? <div className="table-wrap"><table>
              <thead><tr><th>作品</th><th>学生</th><th>类型</th><th>状态</th><th>更新时间</th><th /></tr></thead>
              <tbody>{current.works.map((work) => <tr key={work.source + work.id}>
                <td>{work.title || '未命名作品'}</td><td>{work.studentName || '—'}</td>
                <td>{DELIVERY_LABEL[work.source] || work.source}</td><td>{work.status}</td>
                <td>{formatDate(work.updatedAt || work.submittedAt || work.createdAt)}</td>
                <td>{['CANVAS', 'VIBECODING'].includes(work.source)
                  // ⭐ 2026-10-05 用户口径（图2）：「这里增加个修改作品名称的按钮」——
                  //    与「查看作品」并排；改名后这张表随 `detail.refresh()` 一起更新。
                  ? <div className="row-actions">
                    <button className="text-button" onClick={() => showModal({ kind: 'work', work })}>查看作品</button>
                    <button className="text-button" data-testid="work-rename" onClick={() => showModal({ kind: 'workTitle', work })}>修改作品名称</button>
                  </div>
                  : <span className="muted">暂不支持预览</span>}</td>
              </tr>)}</tbody>
            </table></div> : <p className="muted">暂无作品记录。</p>}
          </Panel>

          <Panel title="课堂事件">
            {current.events?.length ? <ol className="classroom-events">{current.events.map((event) => (
              <li key={event.id}><time>{formatDate(event.createdAt)}</time><div><strong>{event.summary || event.action}</strong><p className="muted">{event.actorName || '系统'}</p></div></li>
            ))}</ol> : <p className="muted">暂无事件记录。</p>}
          </Panel>
        </> : null}

    {/* ⭐ 2026-10-02（用户报「为什么没有分享按钮呢」）：**这里漏传了 canShare / shareCreate** ——
        分享按钮的开关就是这两个 prop，而 ClassroomWork 的默认值是 canShare=false，
        于是"我的课堂 → 查看作品"打开的作品只有「关闭预览」，作品库那条路却有分享。
        发码走机构作用域（与作品库同一条 `/api/org/share-links`，p171 ⑧ 验过课堂老师可以发）。 */}
    {modal?.kind === 'work' ? <ClassroomWork api={api} workBase={`org/sessions/${encodeURIComponent(openId)}/works`} work={modal.work} onClose={closeModal}
      canShare
      onRenamed={() => detail.refresh()}
      shareCreate={(pieceKey) => api.post('org/share-links', { source: modal.work.source || 'CANVAS', workId: modal.work.id, pieceKey })} /> : null}

    {/* 005-03B 修改作品名称（2026-10-05）：与上面同一个弹窗组件，改名后刷新这张表 */}
    {modal?.kind === 'workTitle' ? <RenameWorkDialog api={api} workBase={`org/sessions/${encodeURIComponent(openId)}/works`} work={modal.work}
      onClose={closeModal} onRenamed={() => detail.refresh()} /> : null}

    {/* 005-03A 编辑课堂名称 */}
    {modal?.kind === 'title' ? <Modal title="编辑课堂名称" busy={busy} error={error} onClose={closeModal}
      footer={<><button className="secondary-button" onClick={closeModal}>取消</button>
        <button className="primary-button" disabled={!allowed('canEdit') || busy || Boolean(titleValidation)} onClick={saveTitle}>{busy ? '保存中…' : '保存名称'}</button></>}>
      <InfoStrip items={[
        { label: '当前课堂', value: current?.title || '—', badge: SESSION_STATE[current?.status]?.label },
        { label: '课包 / 课程', value: current?.seriesTitle || '—', note: current?.lessonTitle || null },
        { label: '学生数', value: `${summary.total ?? 0} 人` },
      ]} />
      <label>课堂名称 *<input value={titleDraft} maxLength={50} onChange={(event) => setTitleDraft(event.target.value)} /></label>
    </Modal> : null}

    {/* 005-03C 移除学生确认 */}
    {modal?.kind === 'remove' ? <Modal title="移除学生确认" busy={busy} error={error} onClose={closeModal}
      footer={<><button className="secondary-button" onClick={closeModal}>取消</button>
        <button className="primary-button danger-solid" disabled={!allowed('canRemoveStudents') || busy} onClick={actAndClose}>{busy ? '处理中…' : '确认移除'}</button></>}>
      <InfoStrip items={[
        { label: '当前课堂', value: current?.title || '—', badge: SESSION_STATE[current?.status]?.label },
        { label: '课包 / 课程', value: current?.seriesTitle || '—', note: current?.lessonTitle || null },
        { label: '当前学生数', value: `${summary.total ?? 0} 人` },
      ]} />
      <section className="classroom-block">
        <h4>即将移除学生</h4>
        <div className="classroom-student-card">
          <span className="classroom-avatar" aria-hidden="true">{(modal.student?.studentName || modal.student?.studentLogin || '?').slice(0, 1)}</span>
          <div>
            <strong>{modal.student?.studentName || modal.student?.studentLogin || '该学生'}</strong>
            <div className="muted">登录账号：{modal.student?.studentLogin || '—'}</div>
          </div>
          <StateBadge value={modal.student?.status} map={STUDENT_STATE} />
          <span className="muted">加入时间：{formatDate(modal.student?.addedAt)}</span>
        </div>
      </section>
    </Modal> : null}

    {/* 005-03D 开始上课确认 */}
    {modal?.kind === 'start' ? <Modal title="开始上课确认" busy={busy} error={error} onClose={closeModal}
      footer={<><button className="secondary-button" onClick={closeModal}>取消</button>
        <button className="primary-button" disabled={!allowed('canStart') || busy || startBlocked} onClick={actAndClose}>{busy ? '处理中…' : '确认开始'}</button></>}>
      <InfoStrip items={[
        { label: '即将开始课堂', value: current?.title || '—' },
        { label: '课包 / 课程', value: current?.seriesTitle || '—', note: current?.lessonTitle || null },
        { label: '当前学生数', value: `${summary.pending ?? 0} 人`, note: `教师：${current?.teacherName || '—'}` },
      ]} />
      {precheck.error ? <Notice tone="danger">校验结果读取失败：{precheck.error.message || '请重试'}</Notice> : null}
      <Checklist title="开始前资格校验" checks={checks} />
    </Modal> : null}

    {/* 课堂结束确认（线框图未覆盖；沿用原有口径，不做校验清单） */}
    {modal?.kind === 'end' ? <Modal title="确认结束课堂？" busy={busy} error={error} onClose={closeModal}
      footer={<><button className="secondary-button" onClick={closeModal}>取消</button>
        <button className="primary-button" disabled={!allowed('canEnd') || busy} onClick={actAndClose}>{busy ? '处理中…' : '确认结束'}</button></>}>
    </Modal> : null}

    {/* 005-03E 解散课堂确认 */}
    {modal?.kind === 'dissolve' ? <Modal title="解散课堂确认" busy={busy} error={error} onClose={closeModal}
      footer={<><button className="secondary-button" onClick={closeModal}>取消</button>
        <button className="primary-button danger-solid" disabled={!allowed('canDissolve') || busy || dissolveBlocked} onClick={actAndClose}>{busy ? '处理中…' : '确认解散'}</button></>}>
      <InfoStrip items={[
        { label: '即将解散课堂', value: current?.title || '—' },
        { label: '课包 / 课程', value: courseLine },
        { label: '教师 / 学生', value: `${current?.teacherName || '—'} · ${summary.total ?? 0} 人`, note: '尚未开始上课' },
      ]} />
      {precheck.error ? <Notice tone="danger">校验结果读取失败：{precheck.error.message || '请重试'}</Notice> : null}
      <Checklist title="解散前校验" checks={checks} passedLabel="允许解散" failedLabel="暂不可解散" />
    </Modal> : null}
  </div>;
}
