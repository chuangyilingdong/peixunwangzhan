import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, Empty, ErrorState, formatCredits, formatDate, Loading, MetricCard, Notice, PageHeader, Panel, Pagination, ListResultSummary, Status, useData } from '@platform/shared';
import { ADMIN_PERMISSION_LABELS, WEBSITE_CONTENT_LABELS, downloadCsv, isoDateInput } from '../shared.jsx';
import { BillingSettings } from '../components/BillingSettings.jsx';

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
    setForm({ ...form, channels: form.channels.filter((_, i) => i !== index), modalityChannels: Object.fromEntries(Object.entries(form.modalityChannels).filter(([, v]) => v !== id)) });
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
  // 每个模型可以有自己的请求模板（同渠道里不同模型的请求体可能完全不同）
  const [templateEditor, setTemplateEditor] = useState('');
  function modelTemplateText(channel, modelId) {
    const template = channel?.modelRequestTemplates?.[modelId];
    return template && typeof template === 'object' ? JSON.stringify(template, null, 2) : '';
  }
  function updateModelTemplate(index, modelId, text) {
    const channel = form.channels[index];
    const next = { ...(channel.modelRequestTemplates || {}) };
    const trimmed = String(text || '').trim();
    if (!trimmed) delete next[modelId];
    else {
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        next[modelId] = parsed;
      } catch { return; }
    }
    updateChannel(index, { modelRequestTemplates: next });
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
            <button type="button" className="text-link-button" onClick={() => setTemplateEditor(templateEditor === `${index}:${modelId}` ? '' : `${index}:${modelId}`)}>{templateEditor === `${index}:${modelId}` ? '收起请求模板' : '该模型的请求模板'}</button>
          </div>
          <div className="form-grid">
            {field(modelId, '比例', 'aspectRatios', '16:9, 9:16')}
            {field(modelId, '清晰度', 'resolutions', isVideo ? '480p, 720p' : '1k, 2k')}
            {isVideo ? field(modelId, '时长（秒）', 'durations', '5, 10') : null}
            {isVideo ? <label className="checkbox-label">{modelId} · 支持生成音频<input type="checkbox" checked={declared.audio === true} onChange={(event) => updateModelCapability(index, modelId, { audio: event.target.checked })} /></label> : null}
            {templateEditor === `${index}:${modelId}` ? <label className="capability-template">{modelId} · 该模型的请求模板（只对这个模型生效，优先于渠道模板）<span className="muted">占位符：{'{'}model{'}'} {'{'}prompt{'}'} {'{'}aspectRatio{'}'} {'{'}resolution{'}'} {'{'}durationSeconds{'}'} {'{'}durationSecondsNumber{'}'} {'{'}audio{'}'} {'{'}firstFrameUrl{'}'} {'{'}lastFrameUrl{'}'}。留空＝用渠道/默认模板。整串写 {'{'}durationSecondsNumber{'}'} 会替换成数字，{'{{'}durationSeconds{'}}'} 是字符串。</span><textarea rows={8} value={modelTemplateText(channel, modelId)} placeholder="留空＝用渠道/默认模板" onChange={(event) => updateModelTemplate(index, modelId, event.target.value)} /></label> : null}
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
  async function save(event) { event.preventDefault(); setBusy(true); setMessage(''); try { await api.put('admin/billing-config/ai-provider', form); setMessage('渠道配置已保存'); config.refresh(); } catch (e) { setMessage(e.message || '保存失败'); } finally { setBusy(false); } }
  if (config.loading) return <Panel title="AI 渠道配置"><Loading label="正在读取配置…" /></Panel>;
  if (config.error || !form) return <Panel title="AI 渠道配置"><ErrorState error={config.error || new Error('配置读取失败')} onRetry={config.refresh} /></Panel>;
  return <Panel title="AI 渠道配置">
    <Notice tone="warning">每种能力可以绑定不同渠道和模型。渠道密钥只提交服务器加密保存；点击“测试连接”只验证上游接口，不会生成内容、不扣积分。</Notice>
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
            <label>协议<select value={channel.protocol || 'CHAT'} onChange={(e) => updateChannel(index, { protocol: e.target.value })}><option value="CHAT">Chat Completions</option><option value="RESPONSES">Responses</option><option value="ANTHROPIC">Anthropic Messages</option></select></label>
            <label>Endpoint<input value={channel.endpoint || ''} onChange={(e) => updateChannel(index, { endpoint: e.target.value })} placeholder="https://.../v1" required /></label>
            <label>可用模型（勾选本渠道提供的模型）</label>
            <div className="channel-model-list">
              {(channel.modelMappings || []).map((m) => { const mid = m.id || m.model; const checked = (channel.models || []).includes(mid); return <label key={mid}><input type="checkbox" checked={checked} onChange={(e) => updateChannel(index, { models: e.target.checked ? [...new Set([...(channel.models || []), mid])] : (channel.models || []).filter((x) => x !== mid) })} />{m.displayName || mid}</label>; })}
              {!(channel.modelMappings || []).length ? <small className="muted">点下方「读取模型」获取候选，或手动添加模型 ID</small> : null}
            </div>
            {/* 上面那组勾选框只渲染「候选清单」，所以已启用但不在候选里的模型在这里完全看不见，
                只会在下面的「默认模型」下拉里冒出来（典型是把别家供应商的模型名填了进来）。
                把这种漂移显式暴露出来，并给一键移除——否则它在学生端就是一个必然失败的选项。 */}
            {(() => {
              const candidates = (channel.modelMappings || []).map((m) => m.id || m.model);
              // 默认模型是在下面那个下拉里特意选的，不算漂移（它常常不在候选清单里）
              const orphans = (channel.models || []).filter((m) => !candidates.includes(m) && m !== channel.model);
              if (!orphans.length) return null;
              return <div className="notice warning span-2">
                <strong>⚠ 已启用、但不在候选清单里的模型</strong>
                <div className="row-actions" style={{ margin: '8px 0' }}>
                  {orphans.map((model) => <button
                    type="button"
                    className="secondary-button"
                    key={model}
                    title="从本渠道的启用模型里移除"
                    onClick={() => updateChannel(index, {
                      models: (channel.models || []).filter((x) => x !== model),
                      model: channel.model === model ? '' : channel.model,
                    })}
                  >移除 {model}</button>)}
                </div>
                <small className="muted">通常是别的供应商的模型（或手动输入有误）。它们出现在学生端的模型下拉里，选中就会以当前 Endpoint 去调用，大概率失败。</small>
              </div>;
            })()}
            <label>手动添加模型 ID<input onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value.trim(); if (v) { updateChannel(index, { models: [...new Set([...(channel.models || []), v])] }); e.target.value = ''; } } }} placeholder="输入后回车添加" /></label>
            <label>默认模型{(channel.models || []).length ? <select value={channel.model || ''} onChange={(e) => updateChannel(index, { model: e.target.value })} required><option value="">请选择默认模型</option>{(channel.models || []).map((m) => <option key={m} value={m}>{m}</option>)}</select> : <input value={channel.model || ''} onChange={(e) => updateChannel(index, { model: e.target.value })} placeholder="模型 ID" required />}</label>
            <label>API Key<input type="password" value={channel.apiKey || ''} onChange={(e) => updateChannel(index, { apiKey: e.target.value })} placeholder="留空保持原密钥" autoComplete="new-password" /></label>
          </div>
          {capabilityEditor(channel, index)}
          {channelModality(channel.id) ? <details className="top-gap"><summary>请求模板（可选，高级）</summary><div className="muted">占位符：{'{'}model{'}'} {'{'}prompt{'}'} {'{'}aspectRatio{'}'} {'{'}resolution{'}'} {'{'}durationSeconds{'}'} {'{'}audio{'}'} {'{'}voice{'}'} {'{'}firstFrameUrl{'}'}。留空使用默认模板；若某家模型要求比例/音频放在顶层，把占位符挪到顶层即可。</div><textarea rows={6} value={channelTemplateText(channel)} onChange={(e) => updateChannel(index, { requestTemplates: { ...(channel.requestTemplates || {}), [channelModality(channel.id)]: e.target.value } })} /></details> : null}
          <div className="row-actions top-gap"><button type="button" className="secondary-button" disabled={busy} onClick={() => testChannel(channel)}>测试连接</button><button type="button" className="secondary-button" disabled={busy} onClick={() => fetchModels(channel, index)}>读取模型</button></div>
        </> : null}
      </div>)}
      <div className="top-gap"><strong>能力路由（切换渠道）</strong><div className="muted">这里才是最终生效的选择。同一渠道可以被多个能力使用，也可以随时切换到备用渠道。</div></div>
      <div className="form-grid top-gap">{modalities.map(([id,name])=><label key={id}>{name}<select value={form.modalityChannels[id]||''} onChange={e=>setForm({...form,modalityChannels:{...form.modalityChannels,[id]:e.target.value}})}><option value="">使用默认渠道</option>{form.channels.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>)}</div>
      <label className="checkbox-label top-gap"><input type="checkbox" checked={Boolean(form.allowStudentExternalContent)} onChange={e=>setForm({...form,allowStudentExternalContent:e.target.checked})} />允许学生创作内容发送到外部 AI 服务</label>
      <div className="row-actions top-gap"><button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存全部渠道配置'}</button></div>
    </form>
  </Panel>;
}

export function PlatformBilling({ api }) {
  const organizations = useData(() => api.get('admin/organizations/options'), [api]);
  const overview = useData(() => api.get('admin/billing/usage-overview'), [api]);
  const [filters, setFilters] = useState({ days: '30', orgId: '', modality: '', status: '', search: '', startDate: '', endDate: '' });
  const [page, setPage] = useState(1); const [limit, setLimit] = useState(20); const [sort, setSort] = useState('created');
  const query = useMemo(() => { const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)); params.set('page', String(page)); params.set('limit', String(limit)); params.set('sort', sort); return params; }, [filters, page, limit, sort]);
  const records = useData(() => api.get(`admin/billing/usage-records?${query.toString()}`), [api, query]);
  function updateFilter(key, value) { setFilters((oldFilters) => ({ ...oldFilters, [key]: value })); setPage(1); }
  return <>
    <PageHeader eyebrow="平台计费" title="计费与用量" description="查看全平台魔法石余额、能力消耗、机构排名和用量明细。" actions={<button className="secondary-button" onClick={() => { overview.refresh(); records.refresh(); }}>刷新</button>} />
    <div className="metrics">
      <MetricCard label="机构余额合计" value={formatCredits(overview.data?.totalCredits || 0)} hint="所有机构当前余额合计" />
      <MetricCard label="能力类型" value={overview.data?.usage?.length || 0} hint="已产生消耗的能力类型" tone="teal" />
      <MetricCard label="Top 机构" value={overview.data?.topOrgs?.[0]?.name || '—'} hint={overview.data?.topOrgs?.[0] ? `累计消耗 ${formatCredits(overview.data.topOrgs[0].credits)}` : '暂无消耗'} tone="orange" />
      <MetricCard label="当前明细" value={records.data?.total ?? 0} hint="当前筛选条件命中的记录数" tone="pink" />
    </div>
    <div className="split">
      <Panel title="能力消耗"><table><thead><tr><th>能力</th><th>调用次数</th><th>积分</th></tr></thead><tbody>{(overview.data?.usage || []).map((item) => <tr key={item.modality}><td>{item.modality}</td><td>{item.calls}</td><td>{formatCredits(item.credits)}</td></tr>)}</tbody></table></Panel>
      <Panel title="机构消耗 Top 10"><table><thead><tr><th>机构</th><th>累计消耗</th></tr></thead><tbody>{(overview.data?.topOrgs || []).map((item) => <tr key={item.id}><td>{item.name}</td><td>{formatCredits(item.credits)}</td></tr>)}</tbody></table></Panel>
    </div>
    <ProviderPolicyPanel api={api} />
    <BillingSettings api={api} />

    <Panel title="计费明细筛选">
      <div className="form-grid">
        <label>时间范围<select value={filters.days} onChange={(e) => updateFilter('days', e.target.value)}><option value="1">今日</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="365">近一年</option></select></label>
        <label>开始日期<input type="date" value={filters.startDate} onChange={(e) => updateFilter('startDate', e.target.value)} /></label>
        <label>结束日期<input type="date" value={filters.endDate} onChange={(e) => updateFilter('endDate', e.target.value)} /></label>
        <label>机构<select value={filters.orgId} onChange={(e) => updateFilter('orgId', e.target.value)}><option value="">全部机构</option>{organizations.data?.items?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) || null}</select></label>
        <label>能力<select value={filters.modality} onChange={(e) => updateFilter('modality', e.target.value)}><option value="">全部能力</option><option value="TEXT">TEXT</option><option value="IMAGE">IMAGE</option><option value="MUSIC">MUSIC</option><option value="VIDEO">VIDEO</option></select></label>
        <label>状态<select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)}><option value="">全部状态</option><option value="SUCCESS">成功</option><option value="FAILED">失败</option><option value="BLOCKED">拦截</option></select></label>
        <label>关键词<input value={filters.search} placeholder="机构 / 用户 / 项目 / 作品" onChange={(e) => updateFilter('search', e.target.value)} /></label>
        <label>排序<select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="created">创建时间</option><option value="credits">积分</option></select></label>
        <label>每页数量<select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }}><option value={10}>10 条/页</option><option value={20}>20 条/页</option><option value={50}>50 条/页</option></select></label>
      </div>
    </Panel>
    <Panel title="计费明细">
      {overview.loading || records.loading || organizations.loading ? <Loading label="正在读取计费数据。" /> : records.error ? <ErrorState error={records.error} onRetry={records.refresh} /> : records.data?.items?.length ? <>
        <ListResultSummary total={records.data.total} page={records.data.page} totalPages={records.data.totalPages} label="条记录" />
        <div className="table-wrap"><table><thead><tr><th>时间</th><th>机构 / 用户</th><th>能力 / 模型</th><th>课堂上下文</th><th>积分</th><th>状态</th></tr></thead><tbody>{records.data.items.map((item) => <tr key={item.id}><td>{formatDate(item.createdAt)}</td><td><strong>{item.organizationName || item.orgId}</strong><div className="muted">{item.userName || item.userLogin || item.userId}</div></td><td>{item.modality}<div className="muted">{item.model}</div></td><td>{item.className || '非课堂调用'}{item.projectTitle ? <div className="muted">项目：{item.projectTitle}</div> : null}{item.workTitle ? <div className="muted">作品：{item.workTitle}</div> : null}</td><td>{formatCredits(item.credits)}</td><td><Status value={item.status} /></td></tr>)}</tbody></table></div>
        <Pagination page={records.data.page} totalPages={records.data.totalPages} onChange={setPage} disabled={records.loading} />
      </> : <Empty title="当前筛选条件下无计费记录" body="可以调整时间范围、机构、能力、状态或关键词。" />}
    </Panel>
  </>;
}

