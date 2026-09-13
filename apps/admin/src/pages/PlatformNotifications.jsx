import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';

export function PlatformNotifications({ api }) {
  const [tab, setTab] = useState('dispatch');
  const [eventForm, setEventForm] = useState({ eventKey: '', eventType: '', title: '', body: '', audience: 'TEACHER,STUDENT', orgId: '' });
  const [lastEvent, setLastEvent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failFilters, setFailFilters] = useState({ orgId: '', eventType: '' });
  const failQuery = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(failFilters).forEach(([key, value]) => { if (value) params.set(key, value); });
    params.set('limit', '50');
    return params.toString();
  }, [failFilters]);
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const summary = useData(() => api.get('admin/notification-events/summary'), [api]);
  const queueSummary = useData(() => api.get('admin/notification-queue/summary'), [api]);
  const deadLetters = useData(() => api.get('admin/notification-queue/dead-letters?limit=50'), [api]);
  const events = useData(() => api.get('admin/notification-events?limit=50'), [api]);
  const failures = useData(() => api.get(`admin/notification-failures?${failQuery}`), [api, failQuery]);
  const [selected, setSelected] = useState({});
  const [dlSelected, setDlSelected] = useState({});
  function reset() { setEventForm({ eventKey: '', eventType: '', title: '', body: '', audience: 'TEACHER,STUDENT', orgId: '' }); setMessage(''); }
  async function dispatch(event) {
    event.preventDefault();
    setBusy(true); setMessage('');
    try {
      const audience = { roles: eventForm.audience.split(',').map((s) => s.trim()).filter(Boolean) };
      const payload = {
        eventKey: eventForm.eventKey.trim(),
        eventType: eventForm.eventType.trim(),
        title: eventForm.title.trim(),
        body: eventForm.body.trim(),
        audience,
      };
      if (eventForm.orgId) payload.orgId = eventForm.orgId;
      const result = await api.post('admin/notification-events', payload);
      setLastEvent(result);
      setMessage(`事件已发布：${result.delivered} 投递 / ${result.suppressed} 抑制（共 ${result.totalTargets} 个目标）。`);
      events.refresh(); summary.refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function retryFailures() {
    const ids = Object.values(selected).filter(Boolean);
    if (ids.length === 0) { setMessage('请勾选要重试的失败记录。'); return; }
    setBusy(true); setMessage('');
    try {
      const result = await api.post('admin/notification-failures/retry', { recipientIds: ids });
      setMessage(`已重试 ${result.retried} 条，${result.skipped} 条被跳过（已忽略或达最大次数）。`);
      setSelected({});
      failures.refresh(); summary.refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function ignoreFailures() {
    const ids = Object.values(selected).filter(Boolean);
    if (ids.length === 0) { setMessage('请勾选要忽略的失败记录。'); return; }
    if (!window.confirm(`确认忽略 ${ids.length} 条失败记录？忽略后将从失败列表中移除。`)) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.post('admin/notification-failures/ignore', { recipientIds: ids, reason: 'MANUAL_IGNORE' });
      setMessage(`已忽略 ${result.ignored} 条失败记录。`);
      setSelected({});
      failures.refresh(); summary.refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function tickQueue() {
    setBusy(true); setMessage('');
    try {
      const result = await api.post('admin/notification-queue/tick');
      setMessage(`队列扫描：处理 ${result.processed ?? 0}，成功 ${result.succeeded ?? 0}，失败 ${result.failed ?? 0}。`);
      queueSummary.refresh(); deadLetters.refresh(); failures.refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  async function requeueSelectedDeadLetters() {
    const ids = Object.values(dlSelected).filter(Boolean);
    if (ids.length === 0) { setMessage('请勾选要恢复的死信。'); return; }
    setBusy(true); setMessage('');
    try {
      const result = await api.post('admin/notification-queue/dead-letters/requeue', { jobIds: ids, reason: 'MANUAL_REQUEUE' });
      setMessage(`已恢复 ${result.requeued} 条死信，${result.skipped} 条跳过。`);
      setDlSelected({});
      queueSummary.refresh(); deadLetters.refresh(); failures.refresh();
    } catch (err) { setMessage(err.message); } finally { setBusy(false); }
  }
  return <>
    <PageHeader eyebrow="平台系统" title="通知事件与失败运营" description="站内信（应用内）投递：按 eventKey 投递事件并自动抑制重复；查看、批量重试和忽略投递失败的接收人。当前没有邮件/短信/微信外发通道（按路线图冻结），「失败」指接收人账号已停用或删除，不是外发失败。" actions={<button className="secondary-button" onClick={() => { summary.refresh(); events.refresh(); failures.refresh(); }}>刷新</button>} />
    <Panel title="概要指标">
      {summary.loading ? <Loading /> : summary.error ? <ErrorState error={summary.error} onRetry={summary.refresh} /> : summary.data ? <div className="metrics">
        <MetricCard label="事件总数" value={summary.data.total} hint="已记录的事件源" />
        <MetricCard label="投递总数" value={summary.data.totalRecipients} hint="所有 recipient 记录" tone="teal" />
        <MetricCard label="当前失败" value={summary.data.failed} hint="delivery_status=FAILED 且未忽略" tone="orange" />
        <MetricCard label="已忽略" value={summary.data.suppressed} hint="已手动忽略的失败" tone="pink" />
      </div> : null}
    </Panel>
    <Panel title="投递队列状态">
      {queueSummary.loading ? <Loading /> : queueSummary.error ? <ErrorState error={queueSummary.error} onRetry={queueSummary.refresh} /> : queueSummary.data ? <div>
        <div className="metrics">
          <MetricCard label="待执行" value={queueSummary.data.pending ?? 0} hint="等待 worker 拉取" tone="blue" />
          <MetricCard label="进行中" value={queueSummary.data.inProgress ?? 0} hint="worker 正在处理" tone="teal" />
          <MetricCard label="失败重试" value={queueSummary.data.failed ?? 0} hint="正在指数退避重试" tone="orange" />
          <MetricCard label="死信" value={queueSummary.data.deadLetter ?? 0} hint="达到最大重试次数" tone="red" />
          <MetricCard label="已成功" value={queueSummary.data.succeeded ?? 0} hint="全部投递成功" tone="green" />
        </div>
        <div className="row-actions top-gap">
          <button className="primary-button" disabled={busy} onClick={tickQueue}>立即扫描</button>
          {queueSummary.data.deadLetter > 0 ? <button className="secondary-button" disabled={busy || !Object.values(dlSelected).filter(Boolean).length} onClick={requeueSelectedDeadLetters}>恢复选中死信（{Object.values(dlSelected).filter(Boolean).length}）</button> : null}
          <span className="muted" style={{ fontSize: '0.8em' }}>Worker: {queueSummary.data.workerId || '—'}</span>
        </div>
        {queueSummary.data.deadLetter > 0 ? <div className="table-wrap top-gap"><table><thead><tr><th></th><th>用户</th><th>通知标题</th><th>尝试/上限</th><th>错误码</th><th>错误信息</th><th>更新于</th></tr></thead><tbody>{deadLetters.data?.items?.map ? deadLetters.data.items.map((item) => <tr key={item.id}>
          <td><input type="checkbox" checked={!!dlSelected[item.id]} onChange={(e) => setDlSelected({ ...dlSelected, [item.id]: e.target.checked ? item.id : null })} /></td>
          <td>{item.userName || item.userLogin || item.userId}</td>
          <td>{item.title || '—'}</td>
          <td>{item.attempt}/{item.maxAttempts}</td>
          <td><span className="status danger">{item.lastErrorCode || '—'}</span></td>
          <td className="muted">{item.lastErrorMessage || '—'}</td>
          <td>{formatDate(item.updatedAt)}</td>
        </tr>) : <tr><td colSpan="7" className="muted">加载中…</td></tr>}</tbody></table></div> : null}
      </div> : null}
    </Panel>
    <div className="row-actions">
      <button className={tab === 'dispatch' ? 'primary-button' : 'secondary-button'} onClick={() => setTab('dispatch')}>事件投递</button>
      <button className={tab === 'events' ? 'primary-button' : 'secondary-button'} onClick={() => setTab('events')}>事件列表</button>
      <button className={tab === 'failures' ? 'primary-button' : 'secondary-button'} onClick={() => setTab('failures')}>失败运营（{summary.data?.failed ?? 0}）</button>
    </div>
    {message && <Notice tone={message.includes('已') || message.includes('成功') ? 'success' : 'danger'}>{message}</Notice>}
    {tab === 'dispatch' ? (
      <div className="split">
        <Panel title="投递事件（按 eventKey 抑制重复）">
          <form onSubmit={dispatch}>
            <label>eventKey（4-128 字符）<input value={eventForm.eventKey} placeholder="enrollment-2024-001-abc" onChange={(e) => setEventForm({ ...eventForm, eventKey: e.target.value })} required /></label>
            <label>eventType<input value={eventForm.eventType} placeholder="STUDENT_ENROLLED" onChange={(e) => setEventForm({ ...eventForm, eventType: e.target.value })} required /></label>
            <label>标题<input value={eventForm.title} onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })} required /></label>
            <label>内容<textarea value={eventForm.body} onChange={(e) => setEventForm({ ...eventForm, body: e.target.value })} required /></label>
            <label>角色（逗号分隔）<input value={eventForm.audience} placeholder="TEACHER,STUDENT" onChange={(e) => setEventForm({ ...eventForm, audience: e.target.value })} required /></label>
            <label>机构 ID（留空 = 全平台）<select value={eventForm.orgId} onChange={(e) => setEventForm({ ...eventForm, orgId: e.target.value })}><option value="">全平台</option>{(organizations.data?.items || []).map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
            <div className="row-actions">
              <button type="submit" className="primary-button" disabled={busy}>{busy ? '投递中…' : '投递事件'}</button>
              <button type="button" className="secondary-button" onClick={reset}>重置</button>
            </div>
          </form>
        </Panel>
        <Panel title="最近投递结果">
          {lastEvent ? <>
            <div className="metrics">
              <MetricCard label="事件 ID" value={(lastEvent.id || '').slice(0, 12) + '…'} hint={lastEvent.eventKey} />
              <MetricCard label="状态" value={lastEvent.status} hint={lastEvent.eventType} tone="teal" />
              <MetricCard label="已投递" value={lastEvent.delivered ?? 0} hint="成功插入 recipient 记录" tone="orange" />
              <MetricCard label="已抑制" value={lastEvent.suppressed ?? 0} hint="同 eventKey 已存在" tone="pink" />
            </div>
            <p className="muted">事件总目标：{lastEvent.totalTargets}</p>
          </> : <Empty title="尚未投递事件" body="填写左侧表单，提交后系统会按 eventKey 抑制重复投递。" />}
        </Panel>
      </div>
    ) : null}
    {tab === 'events' ? <Panel title={`事件列表（共 ${events.data?.total ?? 0}）`}>
      {events.loading ? <Loading /> : events.error ? <ErrorState error={events.error} onRetry={events.refresh} /> : events.data?.items.length ? <div className="table-wrap"><table><thead><tr><th>eventKey</th><th>类型</th><th>状态</th><th>机构</th><th>标题</th><th>创建时间</th></tr></thead><tbody>{events.data.items.map((item) => <tr key={item.id}>
        <td><code>{item.eventKey}</code></td>
        <td>{item.eventType}</td>
        <td><Status value={item.status} /></td>
        <td>{item.orgId ? item.orgId.slice(0, 12) + '…' : '平台'}</td>
        <td>{item.title}</td>
        <td>{formatDate(item.createdAt)}</td>
      </tr>)}</tbody></table></div> : <Empty title="暂无事件记录" />}
    </Panel> : null}
    {tab === 'failures' ? <>
      <Panel title="筛选">
        <div className="form-grid">
          <label>机构<select value={failFilters.orgId} onChange={(e) => setFailFilters({ ...failFilters, orgId: e.target.value })}><option value="">全部机构</option>{(organizations.data?.items || []).map((org) => <option key={org.id} value={org.id}>{org.name}</option>)}</select></label>
          <label>事件类型（kind）<input value={failFilters.eventType} placeholder="NOTICE / ANNOUNCEMENT" onChange={(e) => setFailFilters({ ...failFilters, eventType: e.target.value })} /></label>
        </div>
        <div className="row-actions">
          <button className="primary-button" disabled={busy || Object.values(selected).filter(Boolean).length === 0} onClick={retryFailures}>重试选中（{Object.values(selected).filter(Boolean).length}）</button>
          <button className="secondary-button" disabled={busy || Object.values(selected).filter(Boolean).length === 0} onClick={ignoreFailures}>忽略选中</button>
        </div>
      </Panel>
      <Panel title={`失败投递（${failures.data?.total ?? 0}）`}>
        {failures.loading ? <Loading /> : failures.error ? <ErrorState error={failures.error} onRetry={failures.refresh} /> : failures.data?.items.length ? <div className="table-wrap"><table><thead><tr><th></th><th>用户</th><th>机构</th><th>通知</th><th>原因</th><th>重试</th><th>创建时间</th></tr></thead><tbody>{failures.data.items.map((item) => <tr key={item.id}>
          <td><input type="checkbox" checked={!!selected[item.id]} onChange={(e) => setSelected({ ...selected, [item.id]: e.target.checked ? item.id : null })} /></td>
          <td>{item.userName}<div className="muted">{item.userLogin}</div></td>
          <td>{item.orgName || '平台'}</td>
          <td>{item.title}<div className="muted"><code>{item.kind}</code></div></td>
          <td><span className="status danger">{item.failureCode}</span><div className="muted">{item.failureReason}</div></td>
          <td>{item.retryCount}/{item.maxRetries}</td>
          <td>{formatDate(item.createdAt)}</td>
        </tr>)}</tbody></table></div> : <Empty title="当前无失败投递" />}
      </Panel>
    </> : null}
  </>;
}

