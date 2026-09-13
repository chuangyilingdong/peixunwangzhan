// 平台端「模型与算力」页的面板（2026-09-13：从原 ComputeGateway.jsx 拆出）。
//
// 为什么拆：原来「算力网关」和「计费与模型」是两个页面，配一次上游要来回跳（用户反馈理解成本太高）。
// 现在合并成一页、按步骤走，这里放**算力侧的三个面板**：
//   GatewayPanel      ③ 可选的 new-api 网关状态与连接配置
//   PricingPanel      ② 每次调用单价（对学生的售价）
//   ComputeUsagePanel ④ 用量归集 + 算力池 + 两本账对账
// 三个面板各自管自己的数据（互不依赖），所以能独立放进步骤里、也能单独刷新。
import { useEffect, useState } from 'react';
import { ErrorState, Loading, Notice, Panel, formatDate, useData } from '@platform/shared';

/** 金额（元）显示：归集结果里已经是元，别再套积分格式。 */
const yuan = (value) => value == null ? '未知' : `¥${Number(value).toFixed(2)}`;

/* ─────────────── ③ 算力网关：可选的统一调用出口 ─────────────── */
export function GatewayPanel({ api }) {
  const config = useData(() => api.get('admin/compute-gateway'), [api]);
  const [form, setForm] = useState({ baseUrl: '', username: 'root', password: '', enabled: false });
  const [expanded, setExpanded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [testResult, setTestResult] = useState(null);

  // 配置读回来才填表单：密码永不回显，留空表示「不改」
  useEffect(() => {
    if (!config.data?.config || saved) return;
    const value = config.data.config;
    setForm({ baseUrl: value.baseUrl || '', username: value.username || 'root', password: '', enabled: value.enabled === true });
  }, [config.data, saved]);

  const gateway = config.data?.config;
  const enabled = gateway?.enabled === true;
  const configured = Boolean(gateway?.baseUrl && gateway?.passwordConfigured);
  const status = enabled ? (configured ? '已启用' : '配置未完成') : (configured ? '已配置，保持关闭' : '未配置，保持关闭');

  async function save() {
    setBusy(true); setMessage('');
    try {
      const body = { baseUrl: form.baseUrl, username: form.username, enabled: form.enabled };
      if (String(form.password || '').trim()) body.password = String(form.password).trim();
      await api.put('admin/compute-gateway', body);
      setSaved(true); setForm({ ...form, password: '' });
      setMessage('网关配置已保存。'); config.refresh();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setMessage(''); setTestResult(null);
    try {
      const result = await api.request('admin/compute-gateway/test', { method: 'POST', body: {} });
      setTestResult(result); setMessage('连上了。');
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return <Panel
    title="new-api 网关（可选）"
    actions={<button type="button" className="secondary-button" disabled={config.loading} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起配置' : '配置连接'}</button>}
  >
    {config.loading ? <Loading label="正在读取网关状态…" /> : config.error ? <ErrorState error={config.error} onRetry={config.refresh} /> : <>
      <div className="row-actions"><span className={`status ${enabled && configured ? 'success' : ''}`}>{status}</span></div>
      <p>new-api 用于集中管理文本、图片调用出口。未部署或未配置时请保持关闭，平台会继续使用上面的直接渠道，不影响正常生成。</p>
      <p className="muted">当前网关不接管视频和音乐，这两类仍使用平台直接渠道。网关用量与平台估算都不等于供应商最终账单；真实结算金额未知，请以上游供应商账单为准。</p>
      {expanded ? <>
        {message && <Notice tone={message.includes('已') || message.includes('连上') ? 'success' : 'danger'}>{message}</Notice>}
        <div className="form-grid">
          <label>new-api 地址<input value={form.baseUrl} placeholder="例如：http://127.0.0.1:3000" onChange={(event) => { setSaved(false); setForm({ ...form, baseUrl: event.target.value }); }} /></label>
          <label>管理员账号<input value={form.username} placeholder="默认 root" onChange={(event) => { setSaved(false); setForm({ ...form, username: event.target.value }); }} /></label>
          <label>管理员密码<input type="password" value={form.password} placeholder={gateway?.passwordConfigured ? '已配置（留空表示不改）' : 'new-api 后台登录密码'} onChange={(event) => { setSaved(false); setForm({ ...form, password: event.target.value }); }} /></label>
          <label>连接状态<select value={form.enabled ? '1' : '0'} onChange={(event) => { setSaved(false); setForm({ ...form, enabled: event.target.value === '1' }); }}><option value="0">关闭（平台继续使用直接渠道）</option><option value="1">启用网关</option></select></label>
        </div>
        <div className="row-actions top-gap">
          <button type="button" className="primary-button" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存配置'}</button>
          <button type="button" className="secondary-button" disabled={busy || !enabled || !configured} title={enabled && configured ? '' : '先保存完整配置并启用'} onClick={test}>测试连接</button>
          {testResult ? <span className="muted">网关账号 {testResult.gatewayUser || '—'}，耗时 {testResult.latencyMs} ms</span> : null}
        </div>
        <p className="muted">账号与密码来自 new-api 后台，不是平台账号。密码只保存在服务器并且不会回显；保持关闭时不会尝试连接网关。</p>
      </> : null}
    </>}
  </Panel>;
}

/* ─────────────── ② 每次调用单价 ─────────────── */
export function PricingPanel() {
  return <Panel title="用户包算力"><p>学生售价与积分限额已停用。上游估算成本在渠道配置中维护；课时平台预算是每场课堂的总预警基准，超额仍可调用。</p></Panel>;
}

export function ComputeUsagePanel({ api }) {
  const [days,setDays] = useState('30');
  const attempts = useData(() => api.get(`admin/compute-attempts?days=${days}`),[api,days]);
  const budgets = useData(() => api.get('admin/compute-pools?limit=500'),[api]);
  const money = fen => fen == null ? '未知' : yuan(fen / 100);
  const state = {UNKNOWN:'成本未知',OVER_BUDGET:'超额预警（仍可调用）',WITHIN_BUDGET:'已知成本在基准内',UNCONFIGURED:'未配置预警基准'};
  return <>
    <Panel title="上游调用与成本" actions={<><select value={days} onChange={e=>setDays(e.target.value)}><option value="7">近7天</option><option value="30">近30天</option><option value="90">近90天</option></select><button className="secondary-button" onClick={attempts.refresh}>刷新</button></>}>
      <p>用户包算力。估算不代表真实账单；历史售价不作为上游成本，未知成本不按零计算。</p>
      {attempts.loading ? <Loading/> : attempts.error ? <ErrorState error={attempts.error} onRetry={attempts.refresh}/> : <>
        <p>{attempts.data?.summary?.calls || 0} 次尝试 · 已知估算小计 {money(attempts.data?.summary?.estimatedFen)} · 上游报告小计 {money(attempts.data?.summary?.reportedFen)} · 未知 {attempts.data?.summary?.unknownCalls || 0} 次</p>
        <div className="table-wrap"><table><thead><tr><th>时间 / 归属</th><th>模型 / 渠道</th><th>状态</th><th>成本来源 / 金额</th></tr></thead><tbody>{attempts.data?.items?.map(item=><tr key={item.id}><td>{formatDate(item.created_at)}<div>{item.org_name || '未归属'} · {item.student_name || '—'}</div></td><td>{item.model}<div>{item.channel_id} · #{item.attempt}</div></td><td>{item.status}<div>{item.error_code} {item.error_message}</div></td><td>{({UNKNOWN:'未知',ESTIMATED:'估算',REPORTED:'上游报告（未对账）',MOCK:'模拟'})[item.cost_source]} · {money(item.upstream_cost_fen)}</td></tr>)}</tbody></table></div>
      </>}
    </Panel>
    <Panel title="每场课堂平台预警" actions={<button className="secondary-button" onClick={budgets.refresh}>刷新</button>}>
      <p>每场课堂使用课时配置的总预警基准，不随参与人数放大，不阻止学生调用。成本包含失败、在途与成功尝试；未知部分单列。</p>
      {budgets.loading ? <Loading/> : budgets.error ? <ErrorState error={budgets.error} onRetry={budgets.refresh}/> : <div className="table-wrap"><table><thead><tr><th>机构 / 课堂</th><th>参与人数</th><th>预警基准</th><th>已知成本小计</th><th>未知尝试</th><th>预警</th></tr></thead><tbody>{budgets.data?.items?.map(item=><tr key={item.sessionId}><td>{item.orgName} · {item.sessionTitle || item.lessonTitle}</td><td>{item.studentCount}</td><td>{item.budgetFen == null ? '未配置' : money(item.budgetFen)}</td><td>{money(item.knownCostFen)}</td><td>{item.unknownCalls}</td><td>{state[item.budgetState]}</td></tr>)}</tbody></table></div>}
    </Panel>
    <Panel title="课时跨机构汇总">
      <p>相同课时合并所有机构课堂；预警基准合计为每场基准 × 场次，超额课堂单列。</p>
      <div className="table-wrap"><table><thead><tr><th>课时</th><th>机构 / 场次</th><th>预警基准合计</th><th>已知成本小计</th><th>未知尝试 / 超额课堂</th></tr></thead><tbody>{budgets.data?.lessons?.map(item=><tr key={item.lessonId}><td>{item.lessonTitle}</td><td>{item.orgCount} / {item.sessionCount}</td><td>{item.budgetFen == null ? '未配置' : money(item.budgetFen)}</td><td>{money(item.knownCostFen)}</td><td>{item.unknownCalls} / {item.overBudgetSessions}</td></tr>)}</tbody></table></div>
    </Panel>
  </>;
}
