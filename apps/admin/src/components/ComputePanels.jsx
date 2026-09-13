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
const yuan = (value) => `¥${Number(value || 0).toFixed(2)}`;

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
  const [tokenForm, setTokenForm] = useState({ name: '', budgetYuan: '', models: '', unlimited: false });

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

  async function createToken() {
    setBusy(true); setMessage('');
    try {
      const budgetYuan = String(tokenForm.budgetYuan || '').trim();
      if (!tokenForm.unlimited && !/^\d+(?:\.\d{1,2})?$/.test(budgetYuan)) throw new Error('额度请填元金额（最多两位小数），或勾选「不限额度」');
      const budgetFen = tokenForm.unlimited ? 0 : Math.round(Number(budgetYuan) * 100);
      const result = await api.post('admin/compute-gateway/tokens', { name: tokenForm.name, budgetFen, models: tokenForm.models, unlimited: tokenForm.unlimited });
      setMessage(`已分发令牌「${tokenForm.name}」${tokenForm.unlimited ? '（不限额度）' : `，额度 ${budgetYuan} 元`}。`);
      setTokenForm({ name: '', budgetYuan: '', models: '', unlimited: false });
      setTokens((current) => (current ? [...current, result.token].filter(Boolean) : current));
      loadTokens({ keepMessage: true });
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
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

    <Panel title="令牌分发（机构 / 学员 / 课时）" actions={<button className="secondary-button" disabled={busy || !enabled} onClick={loadTokens}>刷新列表</button>}>
      <div className="form-grid">
        <label>令牌名（约定写法）<input value={tokenForm.name} placeholder="机构:org_xxx / 学生:user_xxx / 课时:lesson_xxx" onChange={(event) => setTokenForm({ ...tokenForm, name: event.target.value })} /></label>
        <label>额度（元）<input inputMode="decimal" disabled={tokenForm.unlimited} value={tokenForm.budgetYuan} placeholder="如 50（= 这节课每个学生的算力上限）" onChange={(event) => setTokenForm({ ...tokenForm, budgetYuan: event.target.value })} /></label>
        <label>可用模型（可留空）<input value={tokenForm.models} placeholder="留空 = 不限模型" onChange={(event) => setTokenForm({ ...tokenForm, models: event.target.value })} /></label>
        <label>不限额度<select value={tokenForm.unlimited ? '1' : '0'} onChange={(event) => setTokenForm({ ...tokenForm, unlimited: event.target.value === '1' })}><option value="0">按上面填的额度</option><option value="1">不限额度</option></select></label>
      </div>
      <div className="row-actions top-gap"><button className="primary-button" disabled={busy || !enabled || !tokenForm.name.trim()} onClick={createToken}>{busy ? '分发中…' : '分发令牌'}</button></div>
      <p className="muted">令牌额度＝这条线的算力上限（用尽即被网关拒绝）。令牌名会出现在用量日志里，所以按上面的约定命名，才能把消耗还原到「哪个机构 / 哪个学员 / 哪节课」。</p>
      {tokens ? (tokens.length ? <div className="table-wrap top-gap"><table><thead><tr><th>令牌</th><th>剩余额度</th><th>已用</th><th>模型</th><th>状态</th></tr></thead><tbody>
        {tokens.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.unlimited ? '不限' : formatCredits(item.remainQuota)}</td><td>{formatCredits(item.usedQuota)}</td><td className="muted">{item.models || '不限'}</td><td>{item.status === 1 ? <Status value="ACTIVE" /> : <span className="status danger">已停用</span>}</td></tr>)}
      </tbody></table></div> : <Empty title="还没有令牌" body="给机构/学员/课时分发令牌后，这里会显示它们的额度与消耗。" />) : <p className="muted top-gap">点「刷新列表」读取网关上的令牌（含在 new-api 后台手工建的那些）。</p>}
    </Panel>
  </>;
}

/* ─────────────── ② 每次调用单价 ─────────────── */
export function PricingPanel({ api }) {
  const [pricing, setPricing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [manualModel, setManualModel] = useState('');
  // 模型清单来自**渠道配置**（渠道 → 能力路由 → 该渠道的模型）：直接给真实在用的模型 ID，
  // 不让用户凭记忆手打；不在清单里的也能手工补一个。
  const policy = useData(() => api.get('admin/billing-config/ai-provider'), [api]);
  const routing = policy.data?.policy?.modalityChannels || {};
  const catalog = [];
  for (const channel of policy.data?.policy?.channels || []) {
    const modality = Object.keys(routing).find((key) => routing[key] === channel.id) || '';
    for (const model of channel.models || []) {
      if (model && !catalog.some((item) => item.model === model)) catalog.push({ model, modality, channelName: channel.name || channel.id });
    }
  }

  async function load() {
    setBusy(true); setMessage('');
    try {
      const result = await api.get('admin/compute-pools?limit=1');
      setPricing(result.pricing);
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setMessage('');
    try {
      const result = await api.put('admin/compute-pricing', { perCall: pricing.perCall, models: pricing.models });
      setPricing(result.pricing); setMessage('单价已保存（按「每次调用」折算，立即生效）。');
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return <Panel title="每次调用单价（卖给学生的计价口；含你的毛利）" actions={<button className="secondary-button" disabled={busy} onClick={load}>读取单价</button>}>
    {message && <Notice tone={message.includes('已保存') ? 'success' : 'danger'}>{message}</Notice>}
    {!pricing ? <Empty title="还没有读取" body="点右上角「读取单价」：这四档单价决定算力池怎么扣钱（单价 × 调用次数）。" /> : <>
      <p className="muted">这是<strong>对学生的计费价</strong>（不是上游成本）：池子按「单价 × 调用次数」扣，所以这个价就是你的毛利口径。
        计费<strong>只按次</strong>——没有「按 token 计费」这回事，所以这里就是全部要填的价（上游成本可在步骤④「用量归集」那张表里对，配了网关才有）。
        只要保证<strong>售价不低于上游成本</strong>即可。</p>
      <div className="form-grid">
        {[['TEXT', '对话'], ['IMAGE', '图片'], ['VIDEO', '视频'], ['MUSIC', '音乐']].map(([key, label]) => (
          <label key={key}>{label}（元 / 次）
            <input inputMode="decimal" value={String((pricing.perCall?.[key] ?? 0) / 100)}
              onChange={(event) => setPricing({ ...pricing, perCall: { ...pricing.perCall, [key]: Math.round(Number(event.target.value || 0) * 100) } })} />
          </label>
        ))}
      </div>

      <h4 className="top-gap">按模型单独定价（可选）</h4>
      <p className="muted">上面四档是「按模态」的价，适用于该模态下所有模型。同一模态里成本差异大的档位（例如视频的长时长/高清晰度模型）
        可以在这里<strong>单独定价</strong>：填了就以模型价为准，没填的模型仍用模态价。平台里当前在用的模型已列在下面，也可以手工补一个。</p>
      {(() => {
        const overrides = pricing.models || {};
        const rows = [...new Set([...catalog.map((item) => item.model), ...Object.keys(overrides)])].sort();
        const setModelPrice = (model, yuanText) => {
          const trimmed = String(yuanText || '').trim();
          const next = { ...overrides };
          if (!trimmed) delete next[model];
          else next[model] = Math.round(Number(trimmed || 0) * 100);
          setPricing({ ...pricing, models: next });
        };
        return <>
          {rows.length ? <div className="table-wrap"><table><thead><tr><th>模型</th><th>所属能力</th><th>渠道</th><th>单独单价（元 / 次，留空＝用模态价）</th></tr></thead><tbody>
            {rows.map((model) => {
              const meta = catalog.find((item) => item.model === model) || {};
              return <tr key={model}>
                <td><strong>{model}</strong>{Object.hasOwn(overrides, model) ? <div className="muted">已单独定价</div> : null}</td>
                <td className="muted">{meta.modality || '—'}</td>
                <td className="muted">{meta.channelName || '—'}</td>
                <td><input inputMode="decimal" value={Object.hasOwn(overrides, model) ? String(overrides[model] / 100) : ''} placeholder="留空＝用模态价"
                  onChange={(event) => setModelPrice(model, event.target.value)} /></td>
              </tr>;
            })}
          </tbody></table></div> : <p className="muted">还没有可选的模型：先到步骤① 配好渠道与模型（勾选「可用模型」），这里就会出现。</p>}
          <div className="row-actions top-gap">
            <input value={manualModel} placeholder="手工添加模型 ID（回车）" onChange={(event) => setManualModel(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); const value = manualModel.trim(); if (value) { setModelPrice(value, '0.1'); setManualModel(''); } } }} />
            <button type="button" className="secondary-button" onClick={() => { const value = manualModel.trim(); if (value) { setModelPrice(value, '0.1'); setManualModel(''); } }}>添加模型</button>
          </div>
          {Object.keys(overrides).length ? <p className="muted">已单独定价 {Object.keys(overrides).length} 个模型；保存后立即生效，且<strong>不追溯</strong>已记的账。</p> : null}
        </>;
      })()}

      <div className="row-actions top-gap">
        <button className="primary-button" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存单价'}</button>
        {pricing.updatedAt ? <span className="muted">上次修改：{formatDate(pricing.updatedAt)}</span> : null}
      </div>
    </>}
  </Panel>;
}

/* ─────────────── ④ 用量归集 + 算力池 + 两本账对账 ─────────────── */
export function ComputeUsagePanel({ api }) {
  const config = useData(() => api.get('admin/compute-gateway'), [api]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [usage, setUsage] = useState(null);
  const [usageDays, setUsageDays] = useState(7);
  const [pools, setPools] = useState(null);
  const [budgetedSeries, setBudgetedSeries] = useState([]);
  const [reconcile, setReconcile] = useState(null);
  const [reconcileDays, setReconcileDays] = useState(7);
  const enabled = config.data?.config?.enabled === true;

  async function loadUsage(days = usageDays) {
    setBusy(true); setMessage('');
    try { setUsage(await api.get(`admin/compute-gateway/usage?days=${days}`)); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  async function loadPools() {
    setBusy(true); setMessage('');
    try {
      const result = await api.get('admin/compute-pools?limit=100');
      setPools(result.items || []); setBudgetedSeries(result.budgetedSeries || []);
    } catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  async function loadReconcile(days = reconcileDays) {
    setBusy(true); setMessage('');
    try { setReconcile(await api.get(`admin/compute-pools/reconciliation?days=${days}`)); }
    catch (error) { setMessage(error.message); } finally { setBusy(false); }
  }

  return <>
    {message && <Notice tone="danger">{message}</Notice>}

    <Panel title="用量归集（网关侧：按令牌名还原到机构 / 学员 / 课时）"
      actions={<button className="secondary-button" disabled={busy || !enabled} onClick={() => loadUsage()}>读取用量</button>}>
      {!enabled ? <Empty title="先启用网关" body="启用后这里会按令牌名把网关的消耗还原到机构 / 学员 / 课时。" />
        : !usage ? <Empty title="还没有读取" body="点右上角「读取用量」，看这段时间里哪个机构、哪个学员、哪节课花了多少算力。" />
          : <>
            <div className="row-actions">
              <select value={String(usageDays)} onChange={(event) => { const days = Number(event.target.value); setUsageDays(days); loadUsage(days); }}><option value="1">近 1 天</option><option value="7">近 7 天</option><option value="30">近 30 天</option></select>
              <span className="muted">共 <strong>{usage.calls}</strong> 次调用，合计 <strong>{yuan(usage.totalYuan)}</strong></span>
              {usage.unattributed?.length ? <span className="muted">· 未归属 {usage.unattributed.length} 张令牌（没按约定命名，不计入下面三个维度）</span> : null}
            </div>
            {[['按机构', usage.byOrg, '机构'], ['按学员', usage.byStudent, '学员'], ['按课时', usage.byLesson, '课时']].map(([label, list, unit]) => (
              <div className="top-gap" key={label}>
                <h4>{label}</h4>
                {list?.length ? <div className="table-wrap"><table><thead><tr><th>{unit}</th><th>调用次数</th><th>消耗</th></tr></thead><tbody>
                  {list.map((item) => <tr key={item.key}><td className="muted">{item.key}</td><td>{item.calls}</td><td><strong>{yuan(item.yuan)}</strong></td></tr>)}
                </tbody></table></div> : <p className="muted">这段时间里没有可归集到{unit}的消耗。</p>}
              </div>
            ))}
            {usage.byLessonBudget?.length ? <>
              <h4 className="top-gap">课时预算对照（实际消耗 ÷ 这节课的总预算）</h4>
              <p className="muted">总预算 = 每学生上限 × 参与学生数（排课名单人数），加人会自动放大。视频与音乐目前不走网关，不在这张表里。</p>
              <div className="table-wrap"><table><thead><tr><th>课时</th><th>每学生上限</th><th>参与学生数</th><th>这节课总预算</th><th>实际消耗</th><th>使用率</th></tr></thead><tbody>
                {usage.byLessonBudget.map((item) => <tr key={item.lessonId}>
                  <td><strong>{item.lessonTitle || item.lessonId}</strong><div className="muted">{item.lessonId}</div></td>
                  <td>{yuan(item.perStudentYuan)}</td>
                  <td>{item.studentCount}</td>
                  <td>{yuan(item.budgetYuan)}</td>
                  <td><strong>{yuan(item.usedYuan)}</strong><div className="muted">{item.calls} 次调用</div></td>
                  <td>{item.usagePercent == null ? <span className="muted">还没排学生</span>
                    : <span className={item.usagePercent >= 100 ? 'status danger' : item.usagePercent >= 80 ? 'status warn' : ''}>{item.usagePercent}%</span>}</td>
                </tr>)}
              </tbody></table></div>
            </> : null}
            {usage.unattributed?.length ? <>
              <h4 className="top-gap">未归属（令牌名没按「机构:编号 / 学生:编号 / 课时:编号」命名）</h4>
              <p className="muted">这些消耗金额已算进「合计」，但还原不到具体机构/学员/课时。改掉令牌名或按约定重新分发即可归位。</p>
              <div className="table-wrap"><table><thead><tr><th>令牌</th><th>调用次数</th><th>消耗</th></tr></thead><tbody>
                {usage.unattributed.map((item) => <tr key={item.key}><td className="muted">{item.key}</td><td>{item.calls}</td><td>{yuan(item.yuan)}</td></tr>)}
              </tbody></table></div>
            </> : null}
          </>}
    </Panel>

    <Panel title="算力池（每个学员 × 每个课包一个池子，四种调用共用）" actions={<button className="secondary-button" disabled={busy} onClick={loadPools}>读取池子</button>}>
      {budgetedSeries.length ? <p className="muted">
        已配置「每学生算力上限」的课包：{budgetedSeries.map((item) => `${item.seriesTitle}（¥${item.perStudentYuan}/学生${item.calls ? `，已用 ¥${item.usedYuan}` : '，暂无消耗'}）`).join(' · ')}
      </p> : <p className="muted">还没有课包配置「每学生算力上限」—— 没填的课包不拦、只记账（到课包详情里填）。</p>}
      {!pools ? <Empty title="还没有读取" body="点右上角「读取池子」：看每个学员在某个课包上花了多少、还剩多少（对话 / 图片 / 视频 / 音乐都算进同一个池子）。" />
        : pools.length ? <div className="table-wrap"><table><thead><tr><th>学员</th><th>课包</th><th>上限</th><th>已用</th><th>剩余</th><th>使用率</th><th>调用</th></tr></thead><tbody>
          {pools.map((item) => <tr key={`${item.userId}-${item.seriesId}`}>
            <td><strong>{item.studentName}</strong><div className="muted">{item.orgName}</div></td>
            <td className="muted">{item.seriesTitle}</td>
            <td>{item.unlimited ? <span className="muted">不限</span> : yuan(item.capYuan)}</td>
            <td><strong>{yuan(item.usedYuan)}</strong></td>
            <td>{item.remainYuan == null ? '—' : yuan(item.remainYuan)}</td>
            <td>{item.usagePercent == null ? <span className="muted">—</span>
              : <span className={item.usagePercent >= 100 ? 'status danger' : item.usagePercent >= 80 ? 'status warn' : ''}>{item.usagePercent}%</span>}</td>
            <td className="muted">{item.successCalls} 成功 / {item.failedCalls} 失败</td>
          </tr>)}
        </tbody></table></div> : <Empty title="还没有池子消耗" body="学员开始用 AI 之后，这里会出现「谁在哪个课包上花了多少」。上限在课包的「每学生算力上限（元）」里填，留空 = 不限制、只记账。" />}
    </Panel>

    <Panel title="两本账对账"
      actions={<>
        <select value={String(reconcileDays)} onChange={(event) => { const days = Number(event.target.value); setReconcileDays(days); loadReconcile(days); }}><option value="1">近 1 天</option><option value="7">近 7 天</option><option value="30">近 30 天</option></select>
        <button className="secondary-button" disabled={busy} onClick={() => loadReconcile()}>开始对账</button>
      </>}>
      {!reconcile ? <Empty title="还没有对账" body="点右上角「开始对账」：两本账并排看 —— 池子账（四种模态、按单价折算）与网关账（精确，只含对话/图片）。" />
        : <>
          <p className="muted">
            只拿<strong>重叠模态</strong>（对话 / 图片）比：池子按<strong>售价</strong>记、网关按<strong>上游实耗</strong>记，所以差额主要是<strong>你的毛利</strong>（不是误差）。要看的是「差额是否稳定为正」——为负说明这个模态在亏。
            视频与音乐单列一列 —— 网关看不见它们，所以这部分天然对不上，不是错。
          </p>
          {!reconcile.gatewayEnabled ? <Notice tone="danger">算力网关没启用：网关账这一段必然为空，下面所有行都标成「网关无数据」，无法对账。</Notice> : null}
          <div className="row-actions">
            <span className="muted">池子（对话+图片）<strong>{yuan(reconcile.totals.poolTextImageYuan)}</strong></span>
            <span className="muted">· 网关（精确）<strong>{yuan(reconcile.totals.gatewayYuan)}</strong></span>
            <span className="muted">· 差额<strong>{yuan(reconcile.totals.diffYuan)}</strong></span>
            <span className="muted">· 视频+音乐（网关看不见）<strong>{yuan(reconcile.totals.poolOtherYuan)}</strong></span>
            {reconcile.totals.unmappedGatewayYuan ? <span className="muted">· 网关有 {yuan(reconcile.totals.unmappedGatewayYuan)} 归不到课包（令牌名缺课时段）</span> : null}
          </div>
          {reconcile.items.length ? <div className="table-wrap top-gap"><table><thead><tr><th>学员</th><th>课包</th><th>池子（对话+图片）</th><th>网关（精确）</th><th>差额</th><th>池子相对网关</th><th>视频+音乐</th><th>状态</th></tr></thead><tbody>
            {reconcile.items.map((item) => <tr key={`${item.userId}-${item.seriesId || 'none'}`}>
              <td><strong>{item.studentName}</strong><div className="muted">{item.orgName}</div></td>
              <td className="muted">{item.seriesTitle}</td>
              <td>{yuan(item.poolTextImageYuan)}<div className="muted">{item.poolCalls} 次调用</div></td>
              <td>{yuan(item.gatewayYuan)}<div className="muted">{item.gatewayCalls} 条网关日志</div></td>
              <td><strong>{yuan(item.diffYuan)}</strong></td>
              <td>{item.diffPercent == null ? <span className="muted">—</span>
                : <span className={Math.abs(item.diffPercent) >= 30 ? 'status warn' : ''}>{item.diffPercent}%</span>}</td>
              <td>{yuan(item.poolOtherYuan)}</td>
              <td>{item.state === 'COMPARABLE' ? <Status value="ACTIVE" /> : <span className="muted">网关无数据</span>}</td>
            </tr>)}
          </tbody></table></div> : <Empty title="这段时间没有可对账的消耗" body="池子里还没有成功调用（或这段时间没有调用）。" />}
        </>}
    </Panel>
  </>;
}
