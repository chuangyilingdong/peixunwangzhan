import { useEffect, useMemo, useState } from 'react';
import {
  Empty,
  ErrorState,
  formatDate,
  Loading,
  MetricCard,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Status,
  errorText,
  useData,
} from '@platform/shared';

const TYPE_LABELS = {
  bug: 'Bug 反馈',
  usage: '使用问题',
  feature: '功能建议',
  performance: '性能问题',
};
const STATUS_LABELS = {
  SUBMITTED: '已提交',
  IN_PROGRESS: '开发中',
  RESOLVED: '已解决',
  CLOSED: '已归档',
};

async function downloadAttachment(api, attachment) {
  const objectUrl = await api.fetchBlobUrl(attachment.download_url);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = attachment.filename || 'feedback-attachment';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(objectUrl);
}

function FeedbackDetail({ api, feedbackId, onClose, onUpdated }) {
  const detail = useData(() => feedbackId ? api.get(`admin/client-feedback/${feedbackId}`) : Promise.resolve(null), [api, feedbackId]);
  const [status, setStatus] = useState('IN_PROGRESS');
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reply, setReply] = useState('');

  useEffect(() => {
    if (!detail.data?.raw_status) return;
    setStatus(detail.data.raw_status === 'SUBMITTED' ? 'IN_PROGRESS' : detail.data.raw_status === 'CLOSED' ? 'CLOSED' : 'RESOLVED');
    setResolution(detail.data.resolution || '');
  }, [detail.data?.raw_status, detail.data?.resolution]);

  async function update() {
    setBusy(true); setMessage('');
    try {
      await api.put(`admin/client-feedback/${feedbackId}`, { status, resolution });
      setMessage('处理结果已保存。');
      detail.refresh();
      onUpdated?.();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    if (!reply.trim()) return;
    setBusy(true); setMessage('');
    try {
      await api.post(`admin/client-feedback/${feedbackId}/messages`, { body: reply.trim() });
      setReply('');
      setMessage('回复已发送。');
      detail.refresh();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return <Panel title="客户端反馈详情" actions={<button className="secondary-button" onClick={onClose}>关闭</button>}>
    {detail.error ? <ErrorState error={detail.error} onRetry={detail.refresh} /> : detail.loading || !detail.data ? <Loading /> : <>
      <div className="metrics-row">
        <div className="metric-item"><span className="metric-label">提交人</span><span className="metric-value">{detail.data.reporter?.display_name || detail.data.reporter?.username || detail.data.reporter?.user_id}</span></div>
        <div className="metric-item"><span className="metric-label">类型</span><span className="metric-value">{TYPE_LABELS[detail.data.type] || detail.data.type}</span></div>
        <div className="metric-item"><span className="metric-label">严重度</span><span className="metric-value">{detail.data.severity || '—'}</span></div>
        <div className="metric-item"><span className="metric-label">状态</span><span className="metric-value"><Status value={STATUS_LABELS[detail.data.raw_status] || detail.data.status} /></span></div>
      </div>
      <h3>{detail.data.title}</h3>
      <p style={{ whiteSpace: 'pre-wrap' }}>{detail.data.description}</p>
      <div className="muted">提交于 {formatDate(detail.data.created_at)} · 最近更新 {formatDate(detail.data.updated_at)} · 模块：{detail.data.module || '未指定'}</div>
      {detail.data.contact ? <Notice tone="info">联系方式：{detail.data.contact}</Notice> : null}
      {message ? <Notice tone={message.includes('已') ? 'success' : 'danger'}>{message}</Notice> : null}

      <Panel title="客户端环境">
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(detail.data.device || {}, null, 2)}</pre>
      </Panel>

      <Panel title={`附件 · ${detail.data.attachments?.length || 0}`}>
        {detail.data.attachments?.length ? <div className="row-actions">{detail.data.attachments.map((attachment) => (
          <button key={attachment.id} className="secondary-button" onClick={() => downloadAttachment(api, attachment).catch((error) => setMessage(errorText(error)))}>
            下载 {attachment.filename}（{Math.max(1, Math.round(Number(attachment.size || 0) / 1024))} KB）
          </button>
        ))}</div> : <p className="muted">没有附件。</p>}
      </Panel>

      <Panel title="用户补充与平台回复">
        {detail.data.comments?.length ? <div className="stack">{detail.data.comments.map((comment) => (
          <div key={comment.message_id || comment.id} className="panel-row">
            <strong>{comment.is_staff ? '平台方' : '用户'} · {formatDate(comment.created_at)}</strong>
            <div style={{ whiteSpace: 'pre-wrap' }}>{comment.body}</div>
          </div>
        ))}</div> : <p className="muted">暂无补充消息。</p>}
        <div className="form-grid top-gap">
          <label>平台回复<textarea rows="3" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="补充处理进展或向用户询问信息" /></label>
          <div><button className="secondary-button" disabled={busy || !reply.trim()} onClick={sendReply}>发送回复</button></div>
        </div>
      </Panel>

      <Panel title="处理反馈">
        <div className="form-grid">
          <label>处理状态<select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="IN_PROGRESS">开发中</option>
            <option value="RESOLVED">已解决</option>
            <option value="CLOSED">已归档</option>
          </select></label>
          <label>处理结果<textarea rows="4" value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="已解决/关闭时必填" /></label>
          <div><button className="primary-button" disabled={busy} onClick={update}>{busy ? '保存中…' : '保存处理结果'}</button></div>
        </div>
      </Panel>
    </>}
  </Panel>;
}

export function ClientFeedback({ api }) {
  const [filters, setFilters] = useState({ status: '', type: '', search: '' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [selectedId, setSelectedId] = useState('');
  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    params.set('page', String(page));
    params.set('limit', String(limit));
    return params;
  }, [filters, page, limit]);
  const feedback = useData(() => api.get(`admin/client-feedback?${query.toString()}`), [api, query]);

  return <>
    <PageHeader eyebrow="平台服务" title="客户端问题反馈" description="仅接收灵动ai桌面客户端提交给平台方的反馈，不进入机构或老师处理链路。" actions={<button className="secondary-button" onClick={feedback.refresh}>刷新</button>} />
    <div className="metrics">
      <MetricCard label="待处理" value={feedback.data?.counts?.submitted ?? 0} hint="客户端新提交" tone="orange" />
      <MetricCard label="处理中" value={feedback.data?.counts?.inProgress ?? 0} hint="平台正在跟进" />
      <MetricCard label="已解决" value={feedback.data?.counts?.resolved ?? 0} hint="等待归档" tone="teal" />
      <MetricCard label="已归档" value={feedback.data?.counts?.closed ?? 0} hint="处理闭环" />
    </div>
    <Panel title="筛选条件">
      <div className="form-grid">
        <label>状态<select value={filters.status} onChange={(event) => { setFilters({ ...filters, status: event.target.value }); setPage(1); }}>
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>类型<select value={filters.type} onChange={(event) => { setFilters({ ...filters, type: event.target.value }); setPage(1); }}>
          <option value="">全部类型</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>关键词<input value={filters.search} placeholder="标题 / 描述 / 账号" onChange={(event) => { setFilters({ ...filters, search: event.target.value }); setPage(1); }} /></label>
        <label>每页数量<select value={limit} onChange={(event) => { setLimit(Number(event.target.value)); setPage(1); }}>
          {[10, 20, 50, 100].map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
      </div>
    </Panel>
    <Panel title={`反馈列表 · 共 ${feedback.data?.total ?? 0} 条`}>
      {feedback.loading ? <Loading /> : feedback.error ? <ErrorState error={feedback.error} onRetry={feedback.refresh} /> : feedback.data?.items?.length ? <>
        <div className="table-wrap"><table>
          <thead><tr><th>提交人</th><th>类型 / 标题</th><th>状态</th><th>附件</th><th>设备</th><th>提交时间</th><th>操作</th></tr></thead>
          <tbody>{feedback.data.items.map((item) => <tr key={item.id}>
            <td><strong>{item.userName || item.userLogin || item.userId}</strong><div className="muted">{item.orgName || '平台账号'}</div></td>
            <td>{TYPE_LABELS[item.type] || item.type}<div><strong>{item.title}</strong></div><div className="muted">{item.module || '未指定模块'} · {item.severity || '未定级'}</div></td>
            <td><Status value={STATUS_LABELS[item.status] || item.status} /></td>
            <td>{item.attachmentCount || 0}</td>
            <td><span className="muted">{item.deviceMid || '—'}</span></td>
            <td>{formatDate(item.createdAt)}</td>
            <td><button className="text-button" onClick={() => setSelectedId(item.id)}>查看处理</button></td>
          </tr>)}</tbody>
        </table></div>
        <Pagination page={feedback.data.page} totalPages={feedback.data.totalPages} onChange={setPage} disabled={feedback.loading} />
      </> : <Empty title="暂无客户端反馈" body="客户端提交问题后，会在这里出现。" />}
    </Panel>
    {selectedId ? <FeedbackDetail api={api} feedbackId={selectedId} onClose={() => setSelectedId('')} onUpdated={feedback.refresh} /> : null}
  </>;
}


