import { Fragment, useMemo, useState } from 'react';
import { Empty, ErrorState, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, useData, errorText } from '@platform/shared';
import { downloadCsv } from '../shared.jsx';

/**
 * 联系我们（商机）—— 官网「联系我们」表单提交上来的机构线索。
 *
 * 为什么有这个页面：官网表单 POST /api/public/contact 把提交写进 `leads` 表（status=NEW），
 * 服务端一直有 GET/PUT /api/admin/leads 接口，但**后台此前没有任何页面在读它** ——
 * 用户 2026-09-18 问「提交了我们在哪里可以收到」，答案是当时真的收不到：数据躺在库里没人看见。
 * 这个页面就是那个收件箱。
 *
 * ⚠️ 状态流转必须与后端 `routes/communication/admin.js` 的 VALID_TRANSITIONS 一致；
 *    改后端那张表要同步改这里，否则用户点了按钮会吃 400（INVALID_LEAD_STATUS_TRANSITION）。
 *    这里不用共享的 `Status` 组件：它只把值原样显示（NEW → "NEW"），而这一页要给人看中文。
 */
const NEXT_STATUS = {
  NEW: ['CONTACTED', 'CLOSED'],
  CONTACTED: ['DEMO_SCHEDULED', 'CLOSED'],
  DEMO_SCHEDULED: ['CONVERTED', 'CONTACTED', 'CLOSED'],
  CONVERTED: ['CLOSED'],
  CLOSED: ['CONTACTED'],
};
const STATUS_LABELS = { NEW: '待联系', CONTACTED: '已联系', DEMO_SCHEDULED: '已约演示', CONVERTED: '已转化', CLOSED: '已关闭' };
const STATUS_TONE = { NEW: 'warning', CONTACTED: 'muted', DEMO_SCHEDULED: 'muted', CONVERTED: 'success', CLOSED: 'muted' };
const STATUS_ORDER = ['NEW', 'CONTACTED', 'DEMO_SCHEDULED', 'CONVERTED', 'CLOSED'];

export function Leads({ api }) {
  const [status, setStatus] = useState('');
  const [message, setMessage] = useState('');
  const [openId, setOpenId] = useState('');
  const [draft, setDraft] = useState({ adminNotes: '', assignedTo: '' });
  const query = useMemo(() => { const params = new URLSearchParams(); if (status) params.set('status', status); params.set('limit', '200'); return params; }, [status]);
  const leads = useData(() => api.get(`admin/leads?${query.toString()}`), [api, query]);
  const items = leads.data?.items || [];
  const countOf = (value) => items.filter((item) => item.status === value).length;

  function open(item) {
    if (openId === item.id) { setOpenId(''); return; }
    setOpenId(item.id);
    setDraft({ adminNotes: item.adminNotes || '', assignedTo: item.assignedTo || '' });
    setMessage('');
  }
  async function save(item, nextStatus) {
    setMessage('');
    try {
      await api.put(`admin/leads/${item.id}`, { status: nextStatus || item.status, adminNotes: draft.adminNotes, assignedTo: draft.assignedTo });
      setMessage(nextStatus ? `已把「${item.orgName}」推进到${STATUS_LABELS[nextStatus]}。` : `已保存「${item.orgName}」的跟进记录。`);
      leads.refresh();
    } catch (error) { setMessage(errorText(error)); }
  }
  function exportCsv() {
    const header = ['提交时间', '机构名称', '联系人', '联系电话', '意向', '补充说明', '状态', '跟进记录', '负责人'];
    const lines = items.map((item) => [formatDate(item.createdAt), item.orgName, item.contactName, item.contactPhone, item.intent, item.notes, STATUS_LABELS[item.status] || item.status, item.adminNotes, item.assignedTo || '']
      .map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(','));
    downloadCsv(`联系我们-${new Date().toISOString().slice(0, 10)}.csv`, [header.join(','), ...lines].join('\n'));
  }

  return <>
    <PageHeader eyebrow="平台运营" title="联系我们（商机）" description="官网「联系我们」表单的提交都落在这里（含隐私同意版本与时间）。按「待联系 → 已联系 → 已约演示 → 已转化」推进，沟通结果记在跟进记录里。" actions={<div className="row-actions"><button className="secondary-button" onClick={() => leads.refresh()}>刷新</button><button className="secondary-button" disabled={!items.length} onClick={exportCsv}>导出 CSV</button></div>} />
    {message ? <Notice tone={/失败|不能|无效|不存在|没有权限/.test(message) ? 'danger' : 'success'}>{message}</Notice> : null}
    <div className="metrics">
      <MetricCard label="待联系" value={countOf('NEW')} hint="刚提交、还没人跟进" tone="orange" />
      <MetricCard label="已联系" value={countOf('CONTACTED')} hint="已沟通、待约演示" tone="violet" />
      <MetricCard label="已约演示" value={countOf('DEMO_SCHEDULED')} hint="排了演示时间" tone="teal" />
      <MetricCard label="已转化" value={countOf('CONVERTED')} hint="已成为机构" tone="pink" />
    </div>
    <Panel title={`提交记录（${items.length} 条${status ? ` · 只看${STATUS_LABELS[status]}` : ''}）`}>
      <div className="filters"><select value={status} onChange={(event) => { setStatus(event.target.value); setOpenId(''); }}><option value="">全部状态</option>{STATUS_ORDER.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}</select><span className="muted">共 {items.length} 条（最多拉 200 条）</span></div>
      {leads.loading ? <Loading label="正在读取提交…" /> : leads.error ? <ErrorState error={leads.error} onRetry={leads.refresh} /> : items.length ? <div className="table-wrap"><table><thead><tr><th>提交时间</th><th>机构 / 联系人</th><th>意向</th><th>补充说明</th><th>状态</th><th>操作</th></tr></thead><tbody>{items.map((item) => <Fragment key={item.id}>
        <tr>
        <td>{formatDate(item.createdAt)}</td>
        <td><strong>{item.orgName}</strong><div className="muted">{item.contactName} · {item.contactPhone}</div></td>
        <td>{item.intent || '—'}</td>
        <td>{item.notes ? <span className="muted">{item.notes}</span> : '—'}</td>
        <td><span className={'status ' + (STATUS_TONE[item.status] || 'muted')}>{STATUS_LABELS[item.status] || item.status}</span>{item.assignedTo ? <div className="muted">负责：{item.assignedTo}</div> : null}</td>
        <td><button className="secondary-button" onClick={() => open(item)}>{openId === item.id ? '收起' : '跟进'}</button></td>
      </tr>{openId === item.id ? <tr>
        <td colSpan={6}>
        <div className="form-grid">
          <label>跟进记录<textarea value={draft.adminNotes} placeholder="例如：已电话沟通，约了下周三演示" onChange={(event) => setDraft({ ...draft, adminNotes: event.target.value })} maxLength={2000} /></label>
          <label>负责人<input value={draft.assignedTo} placeholder="谁在跟这条线索（可不填）" onChange={(event) => setDraft({ ...draft, assignedTo: event.target.value })} maxLength={100} /></label>
        </div>
        <div className="row-actions top-gap">
          <button className="primary-button" onClick={() => save(item, '')}>保存跟进记录</button>
          {(NEXT_STATUS[item.status] || []).map((next) => <button className="secondary-button" key={next} onClick={() => save(item, next)}>推进到{STATUS_LABELS[next]}</button>)}
          <span className="muted">隐私同意：{item.legalConsentVersion ? `${item.legalConsentVersion} · ${formatDate(item.legalConsentedAt)}` : '未记录'}</span>
        </div>
      </td></tr> : null}</Fragment>)}</tbody></table></div> : <Empty title={status ? `没有${STATUS_LABELS[status]}的记录` : '还没有收到提交'} body="官网「联系我们」表单提交后会出现在这里；也可以先去官网自己提交一条试试。" />}
    </Panel>
  </>;
}
