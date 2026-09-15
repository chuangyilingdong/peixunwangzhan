// 平台端「模型与算力」页的面板（2026-09-13：从原 ComputeGateway.jsx 拆出）。
//
// 为什么拆：原来「算力网关」和「计费与模型」是两个页面，配一次上游要来回跳（用户反馈理解成本太高）。
// 现在合并成一页，这里放**算力侧的两个面板**：
//   PricingPanel       ② 对外售价（公告价，观测口径）—— 机构/学员看到的「消耗」按它算
//   ComputeBudgetPanel ④ 平台侧成本预警（每场课堂 / 课时跨机构）
//   GatewayPanel       ③ 可选的 new-api 网关状态与连接配置（2026-09-15 起收进「高级」）
// 逐笔明细与按机构/学员对照看「用量与成本」那边的调用账，不在这里重复。
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

/* ─────────────── ② 对外售价（观测口径） ─────────────── */
// 这里维护的是**对外价**：只用于记录「这次调用对外值多少」以便观测与对账。
// 它不扣学生（学生账本恒 0）、不是上游成本；改价也不追溯已记录的售价。
const PRICING_MODALITIES = [['TEXT', '对话'], ['IMAGE', '图片'], ['VIDEO', '视频'], ['MUSIC', '音乐']];

export function PricingPanel({ api }) {
  const pricing = useData(() => api.get('admin/compute-pricing'), [api]);
  const policy = useData(() => api.get('admin/billing-config/ai-provider'), [api]);
  const [perCall, setPerCall] = useState({});
  const [models, setModels] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const value = pricing.data?.pricing;
    if (!value) return;
    setPerCall({ ...(value.perCall || {}) });
    setModels({ ...(value.models || {}) });
  }, [pricing.data]);

  // 模型覆盖按渠道分组：渠道清单来自「渠道与模型配置」，未归属任何渠道的已定价模型单列一组。
  const channels = policy.data?.policy?.channels || [];
  const assigned = new Set(channels.flatMap((channel) => [...(channel.models || []), channel.model].filter(Boolean)));
  const groups = [
    ...channels.map((channel) => ({ id: channel.id, name: channel.name || channel.id, models: [...new Set([...(channel.models || []), channel.model].filter(Boolean))] })),
    { id: '__unassigned__', name: '其他模型（未归属渠道）', models: Object.keys(models).filter((model) => !assigned.has(model)) },
  ];
  const setModelPrice = (model, raw) => setModels((current) => {
    const next = { ...current };
    if (raw === '') delete next[model]; else next[model] = Number(raw);
    return next;
  });

  async function save() {
    setBusy(true); setMessage('');
    try {
      // 空输入不提交（留空的模型回落到模态价）；只送非负整数分。
      const clean = (map) => Object.fromEntries(Object.entries(map)
        .filter(([, value]) => value !== '' && value !== null && Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Number(value)]));
      await api.put('admin/compute-pricing', { perCall: clean(perCall), models: clean(models) });
      setMessage('对外售价已保存。改价只影响之后的调用，不追溯已记录的售价，也不会补扣学生。');
      pricing.refresh();
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return <Panel title="对外售价（观测口径）" actions={<button type="button" className="secondary-button" disabled={pricing.loading} onClick={() => { pricing.refresh(); policy.refresh(); }}>刷新</button>}>
    {pricing.loading ? <Loading label="正在读取对外售价…" /> : pricing.error ? <ErrorState error={pricing.error} onRetry={pricing.refresh} /> : <>
      <Notice tone="info">这里维护的是<b>对外价</b>：只用于记录「这次调用对外值多少」以便观测与对账，<b>不扣学生</b>，也<b>不是上游成本</b>。上游成本请在渠道配置 / 供应商账单里维护。</Notice>
      {message && <Notice tone={message.includes('已保存') ? 'success' : 'danger'}>{message}</Notice>}
      <div className="form-grid">
        {PRICING_MODALITIES.map(([id, name]) => <label key={id}>{name} · 每次调用基础价（分）<input type="number" min="0" step="1" value={perCall[id] ?? ''} onChange={(event) => setPerCall({ ...perCall, [id]: event.target.value === '' ? '' : Number(event.target.value) })} /></label>)}
      </div>
      <p className="muted">没有单独定价的模型按上面的模态基础价计算。</p>
      {groups.map((group) => group.models.length ? <div className="card top-gap" key={group.id}>
        <b>{group.name}</b>
        <div className="form-grid top-gap">{group.models.map((model) => <label key={model}>{model}（分）<input type="number" min="0" step="1" value={models[model] ?? ''} placeholder="留空用模态价" onChange={(event) => setModelPrice(model, event.target.value)} /></label>)}</div>
      </div> : null)}
      {!channels.length ? <p className="muted">暂无渠道，模型清单来自「渠道与模型配置」；也可以先只填模态基础价。</p> : null}
      <div className="row-actions top-gap">
        <button type="button" className="primary-button" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存对外售价'}</button>
        {pricing.data?.pricing?.updatedAt ? <span className="muted">上次更新 {formatDate(pricing.data.pricing.updatedAt)}</span> : null}
      </div>
    </>}
  </Panel>;
}

/**
 * 平台侧的成本预警（按课堂 / 按课时）—— 2026-09-15 重排后挂在「用量与成本 → 三账与毛利」下。
 * 原来这个组件（ComputeUsagePanel）里还有一张「上游调用与成本」表，与「调用账」重复且信息更少
 * （没有对外售价、没有核销与差额），已删掉；逐笔明细一律看调用账。
 */
export function ComputeBudgetPanel({ api }) {
  const budgets = useData(() => api.get('admin/compute-pools?limit=500'),[api]);
  const money = fen => fen == null ? '未知' : yuan(fen / 100);
  const state = {UNKNOWN:'成本未知',OVER_BUDGET:'超额预警（仍可调用）',WITHIN_BUDGET:'已知成本在基准内',UNCONFIGURED:'未配置预警基准'};
  return <>
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
