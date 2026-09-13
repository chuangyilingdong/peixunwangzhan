// 平台端「模型与算力」页的面板（2026-09-13：从原 PlatformBilling.jsx 拆出）。
//
// ProviderPolicyPanel  ① 上游渠道与模型：多渠道 + 每渠道多模型 + 能力路由 + 每模型能力 + 「用当前渠道试一次」
// BillingUsagePanel    ④ 用量与账单：全平台算力消耗、能力分布、机构排名、逐条明细
// 模态开关与预警（BillingSettings）单独作为步骤⑤，由合并页直接引用。
import { useEffect, useMemo, useState } from 'react';
import { Empty, ErrorState, formatDate, formatYuan, Loading, MetricCard, Notice, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { downloadCsv } from '../shared.jsx';

// 视频模型的输入画面支持方式（可多选）：一个模型可以既支持文生、也支持图生/首尾帧。
const INPUT_MODE_OPTIONS = [['TEXT', '文生视频（纯文本）'], ['FIRST_FRAME', '图生视频（首帧图）'], ['FIRST_LAST_FRAME', '首尾帧参考（首帧+尾帧）'], ['OMNI_REFERENCE', '全能参考（多图/多视频/多音频）']];
// 音乐的生成模式（可多选）：歌词生音乐 / 描述生音乐（描述模式由平台先用文本模型代写歌词）
const MUSIC_MODE_OPTIONS = [['LYRICS', '歌词生音乐'], ['DESCRIPTION', '描述生音乐']];

// 读回已声明的方式：既认新的多选数组，也认旧的单值 inputFrame（NONE/FIRST/LAST）。
function inputModesOf(declared, modelId) {
  const value = declared?.inputModes ?? declared?.inputFrame;
  if (value === undefined || value === null || value === '') {
    return /(^|[-_/])i2v($|[-_/])/i.test(String(modelId || '')) ? ['FIRST_FRAME'] : ['TEXT'];
  }
  const aliases = { NONE: 'TEXT', FIRST: 'FIRST_FRAME', LAST: 'FIRST_LAST_FRAME', LAST_FRAME: 'FIRST_LAST_FRAME', OMNI: 'OMNI_REFERENCE', REFERENCE: 'OMNI_REFERENCE' };
  const mapped = (Array.isArray(value) ? value : [value]).map((item) => {
    const text = String(item ?? '').trim().toUpperCase();
    return aliases[text] || text;
  }).filter((item) => INPUT_MODE_OPTIONS.some(([key]) => key === item));
  return mapped.length ? [...new Set(mapped)] : ['TEXT'];
}

export function ProviderPolicyPanel({ api }) {
  const config = useData(() => api.get('admin/billing-config/ai-provider'), [api]);
  const [form, setForm] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState('IMAGE');
  const [routeSearch, setRouteSearch] = useState('');
  // 播客 / 配音已下线，不再出现在配置里
  const modalities = [['TEXT', '文本'], ['IMAGE', '图片'], ['MUSIC', '音乐'], ['VIDEO', '视频']];
  const policy = config.data?.policy;
  const catalog = config.data?.catalog || [];
  useEffect(() => {
    if (policy) setForm({ ...policy, apiKey: '', reason: '', channels: policy.channels || [], modalityChannels: policy.modalityChannels || {} });
  }, [policy]);

  function updateChannel(index, patch) { setForm({ ...form, channels: form.channels.map((item, i) => (i === index ? { ...item, ...patch } : item)) }); }
  function addChannel() {
    const id = `channel-${Date.now().toString(36)}`;
    setForm({ ...form, channels: [...form.channels, { id, name: `新渠道 ${form.channels.length + 1}`, provider: 'custom', model: '', models: [], endpoint: '', protocol: 'CHAT', modalities: [] }] });
    setOpen(id);
  }
  function removeChannel(index) {
    const id = form.channels[index].id;
    setForm({ ...form, channels: form.channels.filter((_, i) => i !== index), modalityChannels: Object.fromEntries(Object.entries(form.modalityChannels).filter(([, v]) => v !== id)), modalityBackupChannels: Object.fromEntries(Object.entries(form.modalityBackupChannels || {}).filter(([, v]) => v !== id)) });
  }
  function channelRequest(channel) { return { endpoint: channel.endpoint, channelId: channel.id, ...(channel.apiKey ? { apiKey: channel.apiKey } : {}) }; }
  // 渠道按「能力路由」确定模态，模型能力按模态归一化。
  function channelModality(channelId) { return Object.entries(form?.modalityChannels || {}).find(([, id]) => id === channelId)?.[0] || ''; }
  function capabilityText(value) { return Array.isArray(value) ? value.join(', ') : ''; }
  function parseCapabilityText(text) { return String(text || '').split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean); }
  // 只合并「已声明」的能力，不把模态默认值写进模型声明（否则默认值会被当成该模型的真实能力）
  function updateModelCapability(index, modelId, patch) {
    const channel = form.channels[index];
    const current = channel.modelCapabilities?.[modelId] || {};
    updateChannel(index, { modelCapabilities: { ...(channel.modelCapabilities || {}), [modelId]: { ...current, ...patch } } });
  }
  function clearModelCapability(index, modelId) {
    const channel = form.channels[index];
    const next = { ...(channel.modelCapabilities || {}) };
    delete next[modelId];
    clearCapabilityDrafts(index, modelId);
    updateChannel(index, { modelCapabilities: next });
  }
  // 输入框要能一边打字一边留住逗号/空格：直接拿解析后的数组回填，逗号会被立刻吃掉，
  // 表现成「只能填一个值」。所以编辑期间先存草稿文本，失焦后再回到规范化后的显示。
  const [capabilityDrafts, setCapabilityDrafts] = useState({});
  const capabilityDraftKey = (index, modelId, key) => `${index}:${modelId}:${key}`;
  function setCapabilityDraft(index, modelId, key, text) {
    setCapabilityDrafts((current) => ({ ...current, [capabilityDraftKey(index, modelId, key)]: text }));
  }
  function clearCapabilityDrafts(index, modelId) {
    const prefix = `${index}:${modelId}:`;
    setCapabilityDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix))));
  }
  // 音乐的生成模式：留空＝两种都支持
  function musicModesOf(declared) {
    const value = declared?.modes;
    if (!Array.isArray(value) || !value.length) return ['LYRICS', 'DESCRIPTION'];
    return value.map((item) => String(item ?? '').trim().toUpperCase()).filter((item) => MUSIC_MODE_OPTIONS.some(([key]) => key === item));
  }
  function channelTemplateText(channel) {
    const modality = channelModality(channel.id);
    const custom = channel.requestTemplates?.[modality];
    if (typeof custom === 'string') return custom;
    if (custom && typeof custom === 'object') return JSON.stringify(custom, null, 2);
    const fallback = config.data?.defaultRequestTemplates?.[modality];
    return fallback ? JSON.stringify(fallback, null, 2) : '';
  }
  /**
   * 模型能力编辑器：只显示该模态真正有意义的字段（文本/音乐等没有比例清晰度），
   * 输入框只显示「已声明」的值，模态默认值放 placeholder —— 默认值不代表该模型的真实能力。
   */
  function capabilityEditor(channel, index) {
    const modality = channelModality(channel.id);
    const defaults = config.data?.capabilityDefaults?.[modality] || {};
    const supportsParams = modality === 'IMAGE' || modality === 'VIDEO';
    const isVideo = modality === 'VIDEO';
    const isMusic = modality === 'MUSIC';
    const field = (modelId, label, key, placeholder) => {
      const declared = channel.modelCapabilities?.[modelId] || {};
      const draft = capabilityDrafts[capabilityDraftKey(index, modelId, key)];
      return <label>{modelId} · {label}<input
        value={draft === undefined ? capabilityText(declared[key]) : draft}
        placeholder={'默认：' + (capabilityText(defaults[key]) || placeholder || '—')}
        onChange={(event) => {
          const text = event.target.value;
          setCapabilityDraft(index, modelId, key, text);
          updateModelCapability(index, modelId, { [key]: parseCapabilityText(text) });
        }}
        onBlur={() => clearCapabilityDrafts(index, modelId)}
      /></label>;
    };
    return <div className="channel-capability-editor top-gap">
      <strong>模型能力（决定课时里能选什么）</strong>
      <div className="muted">这些是「原样发给上游的取值」，平台无法自动识别（多数上游的 /models 只返回模型 ID，不返回能力参数）。只填该模型确实支持的取值，多个用逗号分隔；<b>留空表示不声明，课时里回落到模态默认值</b>。音频只对视频有效；模型名带 -i2v 默认按「需要首帧图」处理，可在此覆盖。</div>
      {supportsParams ? (channel.models || []).map((modelId) => {
        const declared = channel.modelCapabilities?.[modelId] || {};
        const hasDeclared = Object.keys(declared).length > 0;
        const hint = (channel.modelMappings || []).find((item) => String(item.id || item.model) === modelId)?.capabilities;
        return <div className="capability-row top-gap" key={modelId}>
          <div className="row-actions">
            <strong>{modelId}</strong>
            {hasDeclared ? <span className="status success">已声明</span> : <span className="status">未声明（用默认值）</span>}
            {hasDeclared ? <button type="button" className="text-button" onClick={() => clearModelCapability(index, modelId)}>清空声明</button> : null}
            {hint ? <button type="button" className="text-link-button" onClick={() => { clearCapabilityDrafts(index, modelId); updateModelCapability(index, modelId, hint); }}>用上游返回的能力填充</button> : null}
          </div>
          <div className="form-grid">
            {field(modelId, '比例', 'aspectRatios', '16:9, 9:16')}
            {field(modelId, '清晰度', 'resolutions', isVideo ? '480p, 720p' : '1k, 2k')}
            {isVideo ? field(modelId, '时长（秒）', 'durations', '5, 10') : null}
            {isVideo ? <label className="checkbox-label">{modelId} · 支持生成音频<input type="checkbox" checked={declared.audio === true} onChange={(event) => updateModelCapability(index, modelId, { audio: event.target.checked })} /></label> : null}
            {isMusic ? <label>{modelId} · 默认曲风（歌词模式下上游要求曲风必填，学生只写词时用这个）<input value={declared.defaultStyle || ''} placeholder="例如：适合儿童的中文流行歌曲，旋律明亮温暖" onChange={(event) => updateModelCapability(index, modelId, { defaultStyle: event.target.value })} /></label> : null}
            {isMusic ? <label>{modelId} · 生成模式（不选＝两种都支持）<span className="capability-modes">{MUSIC_MODE_OPTIONS.map(([value, label]) => <span key={value}><input type="checkbox" checked={musicModesOf(declared).includes(value)} onChange={(event) => { const current = musicModesOf(declared); const next = event.target.checked ? [...new Set([...current, value])] : current.filter((item) => item !== value); updateModelCapability(index, modelId, { modes: next }); }} />{label}</span>)}</span></label> : null}
            {isVideo ? <label>{modelId} · 输入画面（可多选，不选＝按模型名自动判断）<span className="capability-modes">{INPUT_MODE_OPTIONS.map(([value, label]) => <span key={value}><input type="checkbox" checked={inputModesOf(declared, modelId).includes(value)} onChange={(event) => { const current = inputModesOf(declared, modelId); const next = event.target.checked ? [...new Set([...current, value])] : current.filter((item) => item !== value); updateModelCapability(index, modelId, { inputModes: next, inputFrame: undefined }); }} />{label}</span>)}</span></label> : null}
          </div>
        </div>;
      }) : <div className="muted top-gap">{isMusic ? '音乐渠道：每个模型可以声明支持的生成模式（歌词生音乐 / 描述生音乐）。' : `当前渠道是「${modalities.find(([id]) => id === modality)?.[1] || modality}」模态，没有比例 / 清晰度 / 时长这类参数，无需配置。`}</div>}
      {supportsParams && !(channel.models || []).length ? <div className="muted top-gap">先勾选可用模型，再填写每个模型的能力。</div> : null}
    </div>;
  }
  async function testChannel(channel) { setBusy(true); setMessage(''); try { const result = await api.post('admin/billing-config/ai-provider/test', channelRequest(channel)); setMessage(`${channel.name}：${result.message || '连接成功'}`); } catch (e) { setMessage(`${channel.name}：${e.message || '连接失败'}`); } finally { setBusy(false); } }
  async function fetchModels(channel, index) { setBusy(true); setMessage(''); try { const result = await api.post('admin/billing-config/ai-provider/models', channelRequest(channel)); updateChannel(index, { modelMappings: result.items || [] }); setMessage(`${channel.name}：已读取 ${result.items?.length || 0} 个模型，请勾选本渠道可用模型`); } catch (e) { setMessage(e.message || '获取模型失败'); } finally { setBusy(false); } }
  /**
   * 「用当前渠道试一次」：把这套（可能还没保存的）渠道配置真发一次最小请求。
   * 只验证「上游认不认这套参数」，不扣学生额度，上游可能计费。
   * 刻意**不要求先保存** —— 目的就是在保存前当场知道参数行不行。
   */
  async function probeChannel(channel, modality) {
    if (true) {
      if (!window.confirm(`试一次 ${modality} 会向上游提交真实生成并可能计费，等待时间取决于模态。继续？`)) return;
    }
    setBusy(true); setMessage('');
    try {
      const result = await api.post('admin/billing-config/ai-provider/probe', { modality, channelId: channel.id, model: channel.model, channel, ...(channel.apiKey ? { apiKey: channel.apiKey } : {}) });
      const seconds = Math.round((result.elapsedMs || 0) / 1000);
      if (result.ok) setMessage(`${channel.name} · ${modality}：✓ ${result.message || '上游接受'}（${seconds} 秒）`);
      else if (result.accepted) setMessage(`${channel.name} · ${modality}：上游已受理（${seconds} 秒）—— ${result.error?.message || ''}`);
      else setMessage(`${channel.name} · ${modality}：✗ ${result.error?.message || '上游拒绝了这次请求'}${result.error?.code ? '（' + result.error.code + '）' : ''}`);
    } catch (e) { setMessage(`${channel.name}：${e.message || '探测失败'}`); }
    finally { setBusy(false); }
  }
  async function save(event) { event.preventDefault(); setBusy(true); setMessage(''); try { await api.put('admin/billing-config/ai-provider', form); setMessage('渠道配置已保存，后续请求立即使用新路由；在途请求保留原路由'); config.refresh(); } catch (e) { setMessage(e.message || '保存失败'); } finally { setBusy(false); } }
  if (config.loading) return <Panel title="AI 渠道配置"><Loading label="正在读取配置…" /></Panel>;
  if (config.error || !form) return <Panel title="AI 渠道配置"><ErrorState error={config.error || new Error('配置读取失败')} onRetry={config.refresh} /></Panel>;
  return <Panel title="AI 渠道配置">
    <Notice tone="warning">平台按下面的路由策略选择渠道和模型。测试连接只检查接口可达；“用当前渠道试一次”会发起真实生成，视频和音乐可能运行数分钟并产生上游费用。页面金额是估算或上游报告，真实结算金额未知，请以供应商账单为准。</Notice>
    {message ? <Notice tone={message.includes('失败') || message.includes('错误') ? 'danger' : 'success'}>{message}</Notice> : null}
    <form onSubmit={save}>
      <div className="muted">渠道只负责保存供应商、模型和密钥；具体用哪个渠道，请在下面“能力路由”中切换。</div>
      <div className="row-actions top-gap"><strong>渠道列表</strong><button type="button" className="secondary-button" onClick={addChannel}>＋添加渠道</button></div>
      {!form.channels.length ? <div className="muted top-gap">还没有渠道，请先添加一个。</div> : form.channels.map((channel, index) => <div className="card top-gap" key={channel.id}>
        <div className="row-actions">
          <button type="button" className="link-button" onClick={() => setOpen(open === channel.id ? '' : channel.id)}>{open === channel.id ? '收起' : '展开'}　{channel.name || '未命名渠道'}</button>
          <button type="button" className="danger-button" onClick={() => removeChannel(index)}>删除</button>
        </div>
        {open === channel.id ? <>
          <div className="form-grid top-gap">
            <label>渠道名称<input value={channel.name || ''} onChange={(e) => updateChannel(index, { name: e.target.value })} placeholder="例如：图片-供应商A" required /></label>
            <label>调用地址<input value={channel.endpoint || ''} onChange={(e) => updateChannel(index, { endpoint: e.target.value })} placeholder="https://.../v1" required /></label>
            <label>可用模型（勾选本渠道提供的模型）</label>
            <div className="channel-model-list">
              {/* ⚠️ 这里必须把「候选清单」和「已启用」两个来源合并渲染。
                  只渲染候选的话，不在候选里的已启用模型在界面上看不见，但**仍然在表单状态里**，
                  一保存就会被写回去——2026-09-11 用户就踩了这个：他在库里删掉过 gpt-6-astra，
                  但那个标签页的表单还带着旧值，勾选新模型保存后旧值又被恢复。
                  现在每个已启用项都有勾选框：看得见的，才控制得住。 */}
              {(() => {
                const candidates = (channel.modelMappings || []).map((m) => ({ id: m.id || m.model, label: m.displayName || m.id || m.model, extra: false }));
                const known = new Set(candidates.map((item) => item.id));
                const extras = (channel.models || []).filter((id) => !known.has(id)).map((id) => ({ id, label: id, extra: true }));
                const all = [...candidates, ...extras];
                if (!all.length) return <small className="muted">点下方「读取模型」获取候选，或手动添加模型 ID</small>;
                return all.map((item) => (
                  <label key={item.id} className={item.extra ? 'channel-model-extra' : undefined}>
                    <input
                      type="checkbox"
                      checked={(channel.models || []).includes(item.id)}
                      onChange={(e) => updateChannel(index, { models: e.target.checked ? [...new Set([...(channel.models || []), item.id])] : (channel.models || []).filter((x) => x !== item.id) })} />
                    {item.label}{item.extra ? <em>（不在候选清单）</em> : null}
                  </label>
                ));
              })()}
            </div>
            {/* 提示：勾选框里标着「不在候选清单」的那些通常是别家供应商的模型（或手动输入有误）。
                它们会出现在学生端的模型下拉里，学生选中就以当前 Endpoint 去调用——大概率失败。
                要清理直接在上面取消勾选即可（没有移除按钮是刻意的：勾选框本身就是控制面）。 */}
            {(() => {
              const candidates = (channel.modelMappings || []).map((m) => m.id || m.model);
              // 默认模型是在下面那个下拉里特意选的，不算漂移（它常常不在候选清单里）
              const orphans = (channel.models || []).filter((m) => !candidates.includes(m) && m !== channel.model);
              if (!orphans.length) return null;
              return <div className="notice warning span-2">
                <strong>⚠ 有 {orphans.length} 个已启用的模型不在候选清单里：{orphans.join("、")}</strong>
                <small className="muted">它们会出现在学生端的模型下拉里，选中就以当前 Endpoint 去调用，大概率失败。要清掉就在上面取消勾选。</small>
              </div>;
            })()}
            <label>默认模型{(channel.models || []).length ? <select value={channel.model || ''} onChange={(e) => updateChannel(index, { model: e.target.value })} required><option value="">请选择默认模型</option>{(channel.models || []).map((m) => <option key={m} value={m}>{m}</option>)}</select> : <input value={channel.model || ''} onChange={(e) => updateChannel(index, { model: e.target.value })} placeholder="模型 ID" required />}</label>
            <label>上游估算成本（分 / 次，留空为未知）<input type="number" min="0" step="0.01" value={channel.estimatedCostFen ?? ''} onChange={e => updateChannel(index, { estimatedCostFen: e.target.value === '' ? null : Number(e.target.value) })} /></label><label>API Key<input type="password" value={channel.apiKey || ''} onChange={(e) => updateChannel(index, { apiKey: e.target.value })} placeholder="留空保持原密钥" autoComplete="new-password" /></label>
          </div>
          <details className="top-gap"><summary>高级配置</summary>
            <div className="form-grid top-gap">
              <label>接口协议<select value={channel.protocol || 'CHAT'} onChange={(e) => updateChannel(index, { protocol: e.target.value })}><option value="CHAT">Chat Completions</option><option value="RESPONSES">Responses</option><option value="ANTHROPIC">Anthropic Messages</option></select></label>
              <label>手动添加模型 ID<input onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value.trim(); if (v) { updateChannel(index, { models: [...new Set([...(channel.models || []), v])] }); e.target.value = ''; } } }} placeholder="输入后回车添加" /></label>
            </div>
            {channelModality(channel.id) ? <details className="top-gap"><summary>请求模板</summary><div className="muted">仅在供应商要求特殊请求格式时配置；留空使用平台默认模板。</div><textarea rows={6} value={channelTemplateText(channel)} onChange={(e) => updateChannel(index, { requestTemplates: { ...(channel.requestTemplates || {}), [channelModality(channel.id)]: e.target.value } })} /></details> : null}
          </details>
          <details className="top-gap"><summary>逐模型上游估算成本（分 / 次）</summary>{(channel.models || []).map(model => <label key={model}>{model}<input type="number" min="0" step="0.01" value={channel.modelCosts?.[model] ?? ''} placeholder="留空使用渠道估价" onChange={e => { const costs = {...(channel.modelCosts || {})}; if(e.target.value === '') delete costs[model]; else costs[model] = Number(e.target.value); updateChannel(index,{modelCosts:costs}); }} /></label>)}</details>
          {capabilityEditor(channel, index)}
          <div className="row-actions top-gap"><button type="button" className="secondary-button" disabled={busy} onClick={() => testChannel(channel)}>测试连接</button><button type="button" className="secondary-button" disabled={busy} onClick={() => probeChannel(channel, channelModality(channel.id) || 'TEXT')}>用当前渠道试一次</button><button type="button" className="secondary-button" disabled={busy} onClick={() => fetchModels(channel, index)}>读取模型</button></div>
        </> : null}
      </div>)}
      <div className="top-gap"><strong>能力路由（切换渠道）</strong><div className="muted">主渠道明确拒绝（认证失败、接口不存在、限流）时尝试备用渠道的默认模型。已输出、已受理或结果未知不自动重试；启用网关时主备由网关管理。</div></div>
      <div className="form-grid top-gap">{modalities.map(([id,name])=><div key={id}><label>{name} · 主渠道<select value={form.modalityChannels[id]||''} onChange={e=>setForm({...form,modalityChannels:{...form.modalityChannels,[id]:e.target.value}})}><option value="">使用默认渠道</option>{form.channels.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>{name} · 备用渠道<select value={form.modalityBackupChannels?.[id]||''} onChange={e=>setForm({...form,modalityBackupChannels:{...(form.modalityBackupChannels || {}),[id]:e.target.value}})}><option value="">不配置备用渠道</option>{form.channels.filter(c=>c.id!==form.modalityChannels[id]).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>)}</div>
      <details className="top-gap"><summary>平台路由策略</summary>
        <p className="muted">平台按能力和用户选择的模型决定调用渠道；仅在上游明确拒绝且尚未产出结果时尝试备用。启用 new-api 后，文本和图片的渠道切换由网关管理；视频和音乐仍按这里的直接渠道执行。</p>
        <label className="top-gap">搜索渠道或模型<input value={routeSearch} onChange={(event) => setRouteSearch(event.target.value)} placeholder="输入名称或模型 ID" /></label>
        {(form.modelRoutes || []).map((route,index) => {
          const patch = value => setForm({ ...form, modelRoutes: form.modelRoutes.map((item,i) => i === index ? { ...item,...value } : item) });
          const matches = (value) => !routeSearch.trim() || String(value || '').toLowerCase().includes(routeSearch.trim().toLowerCase());
          const channelOptions = (selectedId) => form.channels.filter((channel) => channel.id === selectedId || matches(channel.name) || matches(channel.id) || (channel.models || []).some(matches));
          const modelOptions = (channelId, selectedModel) => [...new Set(form.channels.find(c => c.id === channelId)?.models || [])].filter((model) => model === selectedModel || matches(model));
          return <div className="form-grid top-gap" key={index}>
          <label>能力<select value={route.modality} onChange={e => patch({modality:e.target.value})}>{modalities.map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label>调用渠道<select value={route.channelId} onChange={e => patch({channelId:e.target.value,model:''})}><option value="">选择渠道</option>{channelOptions(route.channelId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>用户可选模型<select value={route.model} onChange={e => patch({model:e.target.value})}><option value="">选择模型</option>{modelOptions(route.channelId, route.model).map(m => <option key={m}>{m}</option>)}</select></label>
          <label>故障备用渠道<select value={route.backupChannelId || ''} onChange={e => patch({backupChannelId:e.target.value,backupModel:''})}><option value="">不自动切换</option>{channelOptions(route.backupChannelId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>故障备用模型<select disabled={!route.backupChannelId} value={route.backupModel || ''} onChange={e => patch({backupModel:e.target.value})}><option value="">选择模型</option>{modelOptions(route.backupChannelId, route.backupModel).map(m => <option key={m}>{m}</option>)}</select></label>
          <button type="button" className="secondary-button" onClick={() => setForm({...form, modelRoutes:form.modelRoutes.filter((_,i) => i !== index)})}>删除策略</button>
        </div>; })}
        <button type="button" className="secondary-button top-gap" onClick={() => setForm({...form,modelRoutes:[...(form.modelRoutes || []),{modality:'TEXT',channelId:'',model:'',backupChannelId:'',backupModel:''}]})}>添加路由策略</button>
      </details>
      <label className="checkbox-label top-gap"><input type="checkbox" checked={Boolean(form.allowStudentExternalContent)} onChange={e=>setForm({...form,allowStudentExternalContent:e.target.checked})} />允许学生创作内容发送到外部 AI 服务</label>
      <div className="row-actions top-gap"><button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存全部渠道配置'}</button></div>
    </form>
  </Panel>;
}

export function BillingUsagePanel({ api }) {
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const [filters, setFilters] = useState({ days: '30', orgId: '', modality: '', status: '', search: '', startDate: '', endDate: '' });
  const [page, setPage] = useState(1); const [limit, setLimit] = useState(20); const [sort, setSort] = useState('created');
  const [optionSearch, setOptionSearch] = useState('');
  const filterOptions = useData(() => api.get(`admin/billing/filter-options?orgId=${encodeURIComponent(filters.orgId)}`), [api, filters.orgId]);
  const filterPolicy = useData(() => api.get('admin/billing-config/ai-provider'), [api]);
  const channels = filterPolicy.data?.policy?.channels || [];
  const modelOptions = [...new Set(channels.filter(item => !filters.channelId || item.id === filters.channelId).flatMap(item => [...(item.models || []), item.model].filter(Boolean)))].map(id => ({ id, name:id }));
  const choices = [
    ['studentId','学生',(filterOptions.data?.students || []).map(item => ({...item,name:`${item.name || item.login}（${item.login}）`}))],
    ['channelId','渠道',channels], ['model','模型',modelOptions],
    ['seriesId','课包',filterOptions.data?.series || []],
    ['lessonId','课时',(filterOptions.data?.lessons || []).filter(item => !filters.seriesId || item.seriesId === filters.seriesId)],
  ];
  const query = useMemo(() => { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)); params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort); return params; }, [filters, page, limit, sort]);
  const overview = useData(() => api.get(`admin/billing/usage-overview?${query.toString()}`), [api, query]);
  const records = useData(() => api.get(`admin/billing/usage-records?${query.toString()}`), [api, query]);
  const [exportingRecords, setExportingRecords] = useState(false);
  const [exportError, setExportError] = useState('');
  async function exportRecords() {
    setExportingRecords(true); setExportError('');
    try {
      const params = new URLSearchParams(query); params.set('limit','100');
      const all = []; let totalPages = 1;
      for (let next = 1; next <= totalPages; next++) { params.set('page',String(next)); const data = await api.get(`admin/billing/usage-records?${params}`); totalPages = data.totalPages; all.push(...data.items); }
      const cell = value => { let text = String(value ?? ''); if (/^[\s]*[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"','""') + '"'; };
      const lines = [['时间','机构ID','学生ID','模型','状态','失败原因','上游成本（分，空为未知）','上游尝试'].map(cell).join(',')];
      all.forEach(item => lines.push([item.createdAt,item.orgId,item.userId,item.model,item.status,item.failCode,item.costFen,JSON.stringify(item.attempts || [])].map(cell).join(',')));
      downloadCsv('compute-usage.csv',lines.join(String.fromCharCode(13,10)));
    } catch(error) { setExportError(error.message); } finally { setExportingRecords(false); }
  }
  function updateFilter(key, value) { setFilters((oldFilters) => ({ ...oldFilters, [key]: value, ...(key === 'orgId' ? {studentId:''} : {}), ...(key === 'channelId' ? {model:''} : {}), ...(key === 'seriesId' ? {lessonId:''} : {}) })); setPage(1); }
  return <>
    <p className="muted">用户包算力。金额仅为已知上游成本小计，不含未知部分；估算与上游报告不代表已对账付款。历史售价不计入成本。</p>
    <div className="metrics">
      <MetricCard label="已知上游成本小计" value={formatYuan(overview.data?.totalFen || 0)} hint={`当前筛选 · 近 ${filters.days} 日`} />
      <MetricCard label="能力类型" value={overview.data?.usage?.length || 0} hint="已产生消耗的能力类型" tone="teal" />
      <MetricCard label="Top 机构" value={overview.data?.topOrgs?.[0]?.name || '—'} hint={overview.data?.topOrgs?.[0] ? `已知成本小计 ${formatYuan(overview.data.topOrgs[0].costFen)}` : '暂无消耗'} tone="orange" />
      <MetricCard label="当前明细" value={records.data?.total ?? 0} hint="当前筛选条件命中的记录数" tone="pink" />
    </div>
    <div className="split">
      <Panel title="能力已知成本"><table><thead><tr><th>能力</th><th>调用次数</th><th>消耗</th></tr></thead><tbody>{(overview.data?.usage || []).map((item) => <tr key={item.modality}><td>{item.modality}</td><td>{item.calls}</td><td>{item.costFen == null ? '未知' : formatYuan(item.costFen)}</td></tr>)}</tbody></table></Panel>
      <Panel title="机构已知成本 Top 10"><table><thead><tr><th>机构</th><th>已知成本小计</th></tr></thead><tbody>{(overview.data?.topOrgs || []).map((item) => <tr key={item.id}><td>{item.name}</td><td>{item.costFen == null ? '未知' : formatYuan(item.costFen)}</td></tr>)}</tbody></table></Panel>
    </div>

    <Panel title="计费明细筛选" actions={<button className="secondary-button" disabled={exportingRecords} onClick={exportRecords}>{exportingRecords ? '导出中…' : '导出筛选明细 CSV'}</button>}>
      {exportError && <Notice tone="danger">{exportError}</Notice>}
      <div className="form-grid">
        <label>时间范围<select value={filters.days} onChange={(e) => updateFilter('days', e.target.value)}><option value="1">今日</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="365">近一年</option></select></label>
        <label>开始日期<input type="date" value={filters.startDate} onChange={(e) => updateFilter('startDate', e.target.value)} /></label>
        <label>结束日期<input type="date" value={filters.endDate} onChange={(e) => updateFilter('endDate', e.target.value)} /></label>
        <label>机构<select value={filters.orgId} onChange={(e) => updateFilter('orgId', e.target.value)}><option value="">全部机构</option>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) || null}</select></label>
        <label>能力<select value={filters.modality} onChange={(e) => updateFilter('modality', e.target.value)}><option value="">全部能力</option><option value="TEXT">TEXT</option><option value="IMAGE">IMAGE</option><option value="MUSIC">MUSIC</option><option value="VIDEO">VIDEO</option></select></label>
        <label>状态<select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)}><option value="">全部状态</option><option value="SUCCESS">成功</option><option value="FAILED">失败</option><option value="BLOCKED">拦截</option></select></label>
        <label>搜索筛选选项<input value={optionSearch} placeholder="输入学生、渠道、模型或课程名称" onChange={e => setOptionSearch(e.target.value)} /></label>
        {choices.map(([key,label,items]) => <label key={key}>{label}<select disabled={key === 'studentId' && filterOptions.loading} value={filters[key] || ''} onChange={e => updateFilter(key,e.target.value)}><option value="">全部{label}</option>{filters[key] && !items.some(item => item.id === filters[key]) && <option value={filters[key]}>已指定（高级筛选）</option>}{items.filter(item => item.id === filters[key] || String(item.name || item.id).toLowerCase().includes(optionSearch.toLowerCase())).map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select></label>)}
        {(filterOptions.error || filterPolicy.error) && <Notice tone="danger">筛选选项加载失败，请刷新页面重试；也可展开高级筛选输入编号。</Notice>}
        <details><summary>高级筛选 · 精确编号</summary>{[['studentId','学生ID'],['channelId','渠道ID'],['model','模型ID'],['seriesId','课包ID'],['lessonId','课时ID']].map(([key,label]) => <label key={key}>{label}<input value={filters[key] || ''} onChange={e => updateFilter(key,e.target.value)} /></label>)}</details>
        <label>关键词<input value={filters.search} placeholder="机构 / 用户 / 项目 / 作品" onChange={(e) => updateFilter('search', e.target.value)} /></label>
        <label>排序<select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="created">创建时间</option><option value="costFen">消耗</option></select></label>
        <label>每页数量<select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}><option value={10}>10 条/页</option><option value={20}>20 条/页</option><option value={50}>50 条/页</option></select></label>
      </div>
    </Panel>
    <Panel title="计费明细">
      {overview.loading || records.loading || organizations.loading ? <Loading label="正在读取计费数据。" /> : records.error ? <ErrorState error={records.error} onRetry={records.refresh} /> : records.data?.items?.length ? <>
        <ListResultSummary total={records.data.total} page={records.data.page} totalPages={records.data.totalPages} label="条记录" />
        <div className="table-wrap"><table><thead><tr><th>时间</th><th>机构 / 用户</th><th>能力 / 模型</th><th>课堂上下文</th><th>上游成本 / 历史售价</th><th>上游尝试 / 成本</th><th>状态</th></tr></thead><tbody>{records.data.items.map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}</td><td><strong>{item.organizationName || item.orgId}</strong><div className="muted">{item.userName || item.userLogin || item.userId}</div></td><td>{item.modality}<div className="muted">{item.model}</div></td><td>{item.className || '非课堂调用'}{item.projectTitle ? <div className="muted">项目：{item.projectTitle}</div> : null}{item.workTitle ? <div className="muted">作品：{item.workTitle}</div> : null}</td><td>{item.costFen == null ? '未知' : formatYuan(item.costFen)}<div className="muted">历史售价：{formatYuan(item.historicalSaleFen || 0)}（不代表上游成本）</div></td><td>{item.attempts?.length ? item.attempts.map(attempt => <details key={attempt.id}><summary>#{attempt.attempt} {attempt.channelId} · {attempt.model} · {attempt.status}</summary><div>{attempt.costSource === 'ESTIMATED' ? '估算' : attempt.costSource === 'MOCK' ? '模拟' : attempt.costSource === 'REPORTED' ? '上游报告（CNY，未对账）' : '未知'}成本：{attempt.upstreamCostFen == null ? '未知' : formatYuan(attempt.upstreamCostFen)}</div><div>{attempt.errorCode} {attempt.errorMessage}</div>{attempt.taskId && <div>上游任务：{attempt.taskId}</div>}</details>) : <span className="muted">历史未记录，成本未知</span>}</td><td><Status value={item.status} /><div className="muted">{item.failCode}</div></td></tr>)}</tbody></table></div>
        <Pagination page={records.data.page} totalPages={records.data.totalPages} onChange={setPage} disabled={records.loading} />
      </> : <Empty title="当前筛选条件下无计费记录" body="可以调整时间范围、机构、能力、状态或关键词。" />}
    </Panel>
  </>;
}


/* ─────────────── ④ 机构 → 学员 消耗下钻（2026-09-13，用户要的「平台能看到所有机构和下面学生的消耗」）───────────────
 *
 * 归属来自算力池账本（org_id + user_id），**不需要给学生发 key** ——
 * 学生是经我们的后端调用，后端从登录会话就知道是谁，所以新机构/新学员都不用做任何「分发」动作。
 * 左边列所有机构（含这段时间零消耗的，一眼看出谁还没用过），点一家就在右边看它每个学员的汇总，
 * 还能把「机构 × 学员」两级导出成 CSV 交给运营。
 */
export function OrgStudentUsagePanel({ api }) {
  const [days, setDays] = useState('30');
  const [orgId, setOrgId] = useState('');
  const [message, setMessage] = useState('');
  const [exporting, setExporting] = useState(false);
  const report = useData(() => api.get(`admin/billing/org-student-usage?days=${days}&orgId=${encodeURIComponent(orgId)}`), [api, days, orgId]);

  // 选了机构就把它记下来；机构列表刷新后若原来那家没了，退回「全部」
  const orgs = report.data?.orgs || [];
  const selected = orgs.find((item) => item.id === orgId) || null;
  const students = report.data?.students || [];

  async function exportCsv() {
    setExporting(true); setMessage('');
    try {
      const params = new URLSearchParams({ days });
      if (orgId) params.set('orgId', orgId);
      const result = await api.get(`admin/billing/org-student-usage/export?${params.toString()}`);
      downloadCsv(result.filename, result.content);
      setMessage(`已导出 ${result.count} 行${selected ? `（${selected.name}）` : '（全部机构）'}。`);
    } catch (error) { setMessage(error.message); } finally { setExporting(false); }
  }

  return <Panel
    title="按机构看学员消耗（点机构名下钻）"
    actions={<>
      <select value={days} onChange={(event) => setDays(event.target.value)}><option value="1">近 1 天</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option></select>
      <button type="button" className="secondary-button" disabled={exporting} onClick={exportCsv}>{exporting ? '导出中…' : '导出台账 CSV'}</button>
      <button type="button" className="secondary-button" onClick={report.refresh}>刷新</button>
    </>}
  >
    {message ? <Notice tone={message.includes('已导出') ? 'success' : 'danger'}>{message}</Notice> : null}
    {report.loading ? <Loading label="正在读取机构消耗…" /> : report.error ? <ErrorState error={report.error} onRetry={report.refresh} /> : <>
      <p className="muted">
        近 {days} 天：<strong>{report.data?.totals?.orgCount ?? 0}</strong> 家机构里有消耗的{' '}
        <strong>{report.data?.totals?.activeOrgCount ?? 0}</strong> 家，合计 <strong>{formatYuan(report.data?.totals?.costFen || 0)}</strong>、
        {report.data?.totals?.calls ?? 0} 次调用。消耗口径与算力池同一份账本；点机构名看它下面每个学员。
      </p>
      <div className="split">
        <div>
          <h4>机构（近 {days} 天消耗）</h4>
          <div className="table-wrap"><table><thead><tr><th>机构</th><th>消耗</th><th>学员</th><th>调用</th></tr></thead><tbody>
            {orgs.length ? orgs.map((item) => <tr key={item.id} className={item.id === orgId ? 'is-selected' : undefined}>
              <td><button type="button" className="link-button" onClick={() => setOrgId(item.id === orgId ? '' : item.id)}>{item.name}</button>
                <div className="muted">{item.status}{item.calls ? '' : ' · 这段时间没消耗'}</div></td>
              <td><strong>{item.costFen == null ? '未知' : formatYuan(item.costFen)}</strong></td>
              <td>{item.studentCount}</td>
              <td className="muted">{item.calls}</td>
            </tr>) : <tr><td colSpan="4"><Empty title="还没有机构" /></td></tr>}
          </tbody></table></div>
        </div>
        <div>
          <h4>{selected ? `${selected.name} · 每个学员的消耗` : '选一家机构看学员明细'}</h4>
          {!selected ? <Empty title="还没有选机构" body="点左边任意一家机构，这里会列出它下面每个学员的消耗、涉及课包数和最近一次调用时间。" />
            : students.length ? <div className="table-wrap"><table><thead><tr><th>学员</th><th>调用</th><th>消耗</th><th>课包</th><th>最近一次</th></tr></thead><tbody>
              {students.map((item) => <tr key={item.id}>
                <td><strong>{item.name}</strong><div className="muted">{item.login}</div></td>
                <td>{item.calls}</td>
                <td><strong>{item.costFen == null ? '未知' : formatYuan(item.costFen)}</strong></td>
                <td>{item.seriesCount}</td>
                <td className="muted">{item.lastAt ? formatDate(item.lastAt) : '—'}</td>
              </tr>)}
            </tbody></table></div> : <Empty title="这家机构这段时间没有消耗" body="换个时间范围，或确认学员是否已经用上 AI。" />}
        </div>
      </div>
    </>}
  </Panel>;
}
