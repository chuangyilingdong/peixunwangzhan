// 官网预约线索（商机）管理：官网「预约演示」表单提交后在这里跟进。
import { useState } from 'react';
import { Empty, ErrorState, Loading, MetricCard, Notice, PageHeader, Panel, formatDate, useData } from '@platform/shared';

const LEAD_STATUS_LABELS = {
  NEW: '待跟进',
  CONTACTED: '已联系',
  DEMO_SCHEDULED: '已约演示',
  CONVERTED: '已转化',
  CLOSED: '已关闭',
};
// 与后端 VALID_TRANSITIONS 保持一致，避免前端给出会被拒绝的选项
const LEAD_TRANSITIONS = {
  NEW: ['CONTACTED', 'CLOSED'],
  CONTACTED: ['DEMO_SCHEDULED', 'CLOSED'],
  DEMO_SCHEDULED: ['CONVERTED', 'CONTACTED', 'CLOSED'],
  CONVERTED: ['CLOSED'],
  CLOSED: ['CONTACTED'],
};
const STATUS_TONE = { NEW: 'warning', CONTACTED: '', DEMO_SCHEDULED: '', CONVERTED: 'success', CLOSED: 'danger' };

function LeadStatus({ value }) {
  return <span className={`status ${STATUS_TONE[value] || ''}`}>{LEAD_STATUS_LABELS[value] || value}</span>;
}

export function LeadManagement({ api }) {
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ status: '', adminNotes: '', assignedTo: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const list = useData(() => api.get('admin/leads' + (status ? '?status=' + status : '')), [api, status]);

  const items = list.data?.items || [];
  const kw = keyword.trim().toLowerCase();
  const visible = kw
    ? items.filter((item) => [item.orgName, item.contactName, item.contactPhone, item.intent, item.notes]
      .some((value) => String(value || '').toLowerCase().includes(kw)))
    : items;
  const counts = items.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});

  function open(item) {
    setSelected(item);
    setForm({ status: item.status, adminNotes: item.adminNotes || '', assignedTo: item.assignedTo || '' });
    setMessage('');
  }

  async function save(event) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setMessage('');
    try {
      const saved = await api.put('admin/leads/' + encodeURIComponent(selected.id), {
        status: form.status, adminNotes: form.adminNotes, assignedTo: form.assignedTo,
      });
      setSelected(saved);
      setForm({ status: saved.status, adminNotes: saved.adminNotes || '', assignedTo: saved.assignedTo || '' });
      setMessage(`已更新为「${LEAD_STATUS_LABELS[saved.status] || saved.status}」。`);
      list.refresh();
    } catch (error) { setMessage(error.message); }
    finally { setSaving(false); }
  }

  const nextStatuses = selected ? [selected.status, ...(LEAD_TRANSITIONS[selected.status] || [])] : [];

  return <>
    <PageHeader
      eyebrow="运营中心"
      title="预约线索"
      description="官网「预约演示」表单提交的机构线索。在这里记录跟进结果、推进状态；线索本身来自公开表单，已带法务同意记录。"
      actions={<button className="secondary-button" onClick={list.refresh}>刷新</button>}
    />

    <div className="metrics">
      <MetricCard label="全部线索" value={items.length} hint="当前筛选范围" tone="violet" />
      <MetricCard label="待跟进" value={counts.NEW || 0} hint="还没联系过" tone="orange" />
      <MetricCard label="已约演示" value={counts.DEMO_SCHEDULED || 0} hint="等待演示或转化" tone="teal" />
      <MetricCard label="已转化" value={counts.CONVERTED || 0} hint="已签约机构" tone="pink" />
    </div>

    <Panel title="筛选">
      <div className="form-grid">
        <label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(LEAD_STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>关键词<input value={keyword} placeholder="机构 / 联系人 / 电话 / 意向" onChange={(event) => setKeyword(event.target.value)} /></label>
      </div>
    </Panel>

    {list.loading ? <Loading label="正在读取线索…" /> : null}
    {list.error ? <ErrorState error={list.error} onRetry={list.refresh} /> : null}

    {!list.loading && !list.error ? <Panel title={`线索列表（${visible.length}）`}>
      <div className="table-wrap"><table>
        <thead><tr><th>提交时间</th><th>机构</th><th>联系人</th><th>意向</th><th>状态</th><th>跟进人</th><th>操作</th></tr></thead>
        <tbody>
          {visible.map((item) => <tr key={item.id}>
            <td>{formatDate(item.createdAt)}</td>
            <td><strong>{item.orgName}</strong>{item.notes ? <div className="muted">{item.notes}</div> : null}</td>
            <td>{item.contactName}<div className="muted">{item.contactPhone}</div></td>
            <td>{item.intent || '—'}</td>
            <td><LeadStatus value={item.status} /></td>
            <td>{item.assignedTo || <span className="muted">未分配</span>}</td>
            <td><button className="secondary-button" onClick={() => open(item)}>跟进</button></td>
          </tr>)}
          {!visible.length ? <tr><td colSpan="7"><Empty title="暂无线索" body="官网提交「预约演示」后会出现在这里。" /></td></tr> : null}
        </tbody>
      </table></div>
    </Panel> : null}

    {selected ? <Panel title={`跟进：${selected.orgName}`}>
      <div className="row-actions canvas-meta">
        <span className="muted">联系人：{selected.contactName} · {selected.contactPhone}</span>
        <span className="muted">提交于 {formatDate(selected.createdAt)}</span>
        {selected.legalConsentVersion ? <span className="muted">法务同意 {selected.legalConsentVersion}</span> : null}
      </div>
      {selected.notes ? <p className="muted">机构备注：{selected.notes}</p> : null}
      <form onSubmit={save}>
        <div className="form-grid">
          <label>状态<select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })}>
            {nextStatuses.map((value) => <option key={value} value={value}>{LEAD_STATUS_LABELS[value] || value}{value === selected.status ? '（当前）' : ''}</option>)}
          </select></label>
          <label>跟进人<input value={form.assignedTo} maxLength="100" placeholder="谁在跟这条线索" onChange={(event) => setForm({ ...form, assignedTo: event.target.value })} /></label>
          <label className="span-2">跟进记录<textarea rows="3" maxLength="2000" value={form.adminNotes} placeholder="联系结果、下一步安排…" onChange={(event) => setForm({ ...form, adminNotes: event.target.value })} /></label>
        </div>
        <div className="row-actions">
          <button className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存跟进'}</button>
          <button type="button" className="secondary-button" onClick={() => setSelected(null)}>关闭</button>
        </div>
      </form>
      {message ? <Notice tone={message.includes('已更新') ? 'success' : 'danger'}>{message}</Notice> : null}
    </Panel> : null}
  </>;
}
