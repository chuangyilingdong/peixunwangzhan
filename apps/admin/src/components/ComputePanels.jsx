// 平台端「模型与算力」页的面板（2026-09-13：从原 ComputeGateway.jsx 拆出）。
//
// 为什么拆：原来「算力网关」和「计费与模型」是两个页面，配一次上游要来回跳（用户反馈理解成本太高）。
// 现在合并成一页、按步骤走，这里放**算力侧的三个面板**：
//   GatewayPanel      ③ 算力网关连接 + 渠道池 + 令牌分发（可选的精确计费出口）
//   PricingPanel      ② 每次调用单价（对学生的售价）
//   ComputeUsagePanel ④ 用量归集 + 算力池 + 两本账对账
// 三个面板各自管自己的数据（互不依赖），所以能独立放进步骤里、也能单独刷新。
import { useEffect, useState } from 'react';
import { Empty, ErrorState, Loading, Notice, Panel, Status, formatCredits, formatDate, useData } from '@platform/shared';

/** 金额（元）显示：归集结果里已经是元，别再套积分格式。 */
const yuan = (value) => value == null ? '未知' : `¥${Number(value).toFixed(2)}`;

/* ─────────────── ③ 算力网关：连接 + 渠道池 + 令牌分发 ─────────────── */
export function GatewayPanel({ api }) {
  const config = useData(() => api.get('admin/compute-gateway'), [api]);
  const [form, setForm] = useState({ baseUrl: '', username: 'root', password: '', enabled: false });
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [channels, setChannels] = useState(null);
  const [tokens, setTokens] = useState(null);

  // 配置读回来才填表单：密码永不回显，留空表示「不改」
  useEffect(() => {
    if (!config.data?.config || saved) return;
    const value = config.data.config;
    setForm({ baseUrl: value.baseUrl || '', username: value.username || 'root', password: '', enabled: value.enabled === true });
  }, [config.data, saved]);

  const enabled = config.data?.config?.enabled === true;

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

  async function loadChannels() {
    setBusy(true); setMessage('');
    try { setChannels((await api.get('admin/compute-gateway/channels')).items || []); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  async function loadTokens({ keepMessage = false } = {}) {
    setBusy(true); if (!keepMessage) setMessage('');
    try { setTokens((await api.get('admin/compute-gateway/tokens')).items || []); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return <>
    {message && <Notice tone={message.includes('已') || message.includes('连上') ? 'success' : 'danger'}>{message}</Notice>}

    <Panel title="网关连接（没有网关就跳过这一块）">
      {config.loading ? <Loading /> : config.error ? <ErrorState error={config.error} onRetry={config.refresh} /> : <>
        <div className="form-grid">
          <label>new-api 的地址<input value={form.baseUrl} placeholder="和平台同一台机器：http://127.0.0.1:3000；独立机器：http://服务器IP:3000" onChange={(event) => { setSaved(false); setForm({ ...form, baseUrl: event.target.value }); }} /></label>
          <label>new-api 的管理员账号<input value={form.username} placeholder="new-api 后台的账号，默认 root" onChange={(event) => { setSaved(false); setForm({ ...form, username: event.target.value }); }} /></label>
          <label>new-api 的管理员密码<input type="password" value={form.password} placeholder={config.data?.config?.passwordConfigured ? '已配置（留空表示不改）' : 'new-api 后台的登录密码'} onChange={(event) => { setSaved(false); setForm({ ...form, password: event.target.value }); }} /></label>
          <label>启用<select value={form.enabled ? '1' : '0'} onChange={(event) => { setSaved(false); setForm({ ...form, enabled: event.target.value === '1' }); }}><option value="0">未启用（保持默认就好：AI 调用直接走上游，额度与归属照样算）</option><option value="1">启用（调用改走网关）</option></select></label>
        </div>
        <div className="row-actions top-gap">
          <button className="primary-button" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存配置'}</button>
          <button className="secondary-button" disabled={busy || !enabled} title={enabled ? '' : '先保存并启用'} onClick={test}>测试连接</button>
          {testResult ? <span className="muted">连上了：网关账号 {testResult.gatewayUser || '—'}，耗时 {testResult.latencyMs} ms</span> : null}
        </div>
        <p className="muted">这里填的是 <strong>new-api 后台的账号</strong>（和你的平台账号无关），密码加密存在服务器的密钥文件里（AES-256-GCM）、不回显、不落库；换网关或换账号时重填一次。没有网关？这一块跳过就行，不影响其他步骤。</p>
      </>}
    </Panel>

    <Panel title="渠道池（只读，渠道与密钥在网关上维护）" actions={<button className="secondary-button" disabled={busy || !enabled} onClick={loadChannels}>读取渠道</button>}>
      {!enabled ? <Empty title="先启用网关" body="启用并测连成功后，这里会显示网关上的渠道（主用/备用）。" />
        : !channels ? <Empty title="还没有读取" body="点右上角「读取渠道」，或者在渠道出问题时用它确认备用渠道是否还在。" />
          : channels.length ? <div className="table-wrap"><table><thead><tr><th>渠道</th><th>地址</th><th>模型</th><th>状态</th></tr></thead><tbody>
            {channels.map((item) => <tr key={item.id}><td><strong>{item.name}</strong><div className="muted">#{item.id} · {item.group || '默认分组'}</div></td><td className="muted">{item.baseUrl || '—'}</td><td className="muted">{item.models || '—'}</td><td>{item.status === 1 ? <Status value="ACTIVE" /> : <span className="status danger">已停用</span>}</td></tr>)}
          </tbody></table></div> : <Empty title="网关上还没有渠道" body="请先在 new-api 里配置渠道与密钥。" />}
    </Panel>

    <Panel title="内部调用身份" actions={<button className="secondary-button" disabled={busy || !enabled} onClick={loadTokens}>刷新身份</button>}>
      <p>机构与学生身份由服务器自动管理，密钥不发送到浏览器。学生调用不限金额；课堂预算仅供平台预警。旧手工令牌的额度不作为学生预算。</p>
      {tokens?.map(item => <p key={item.id}>{item.name} · {item.status === 1 ? '启用' : '停用'}</p>)}
    </Panel>
  </>;
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
