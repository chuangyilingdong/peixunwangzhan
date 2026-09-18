// 平台端「AI 能力与价格」页的面板（2026-09-13：从原 PlatformBilling.jsx 拆出）。
//
// AiCapabilityPanel  「渠道与价格」整页就是三块（2026-09-18 用户口径「大量减法、简单明了」）：
//   ① 渠道         —— 每张卡只有 4 项必填（名称 / 调用地址 / 可用模型 / 默认模型）+ 供应商账户标识 + API Key，
//                     外加折叠的「高级配置」（手动模型 ID、请求模板）。
//   ② 价目表       —— 一行 = 渠道 × 模型，**成本价 / 实测价 / 对外价并排**（"这个渠道的这个模型多少钱"的唯一真相表）。
//                     实测价（2026-09-18 P92）= 上游逐笔实扣 ÷ 用量（滚动近 N 天，只算 REPORTED），
//                     用来校合同价；样本不足不给数，要写进合同价由人点「采纳为成本价」。
//   ③ 路由与开关   —— 能力路由 / 读图渠道 / 平台路由策略 / 学生外发开关 / 四个模态总开关（原来散在三个折叠里）。
//
// OrgStudentUsagePanel  机构 → 学员 消耗下钻（「用量与成本」页用，不动）。
//
// 2026-09-18 删掉/搬走的东西与理由（都是用户口径，不是随手清）：
//   · 「上游估算成本（分/次）」+「逐模型上游估算成本」两个输入框 —— 口径「成本价只留价目表一套」。
//     它们本来就被合同单价压住（取值链 MOCK > REPORTED > COMPUTED > ESTIMATED），填了合同单价就是白填。
//   · 「上游合同单价」「模型能力」从渠道卡搬进价目表 —— 原来默认展开、各占好几屏，同一个模型要在 4 个地方各填一次。
//   · 「算力网关」（new-api）整块 UI —— 生产未启用（上游本身已经是网关），留在页面上只会让人以为要配。
//   · BillingUsagePanel（2026-09-18 更早一步删掉）—— 全仓零引用，里面那套 14 字段筛选表单从来没人能看到。
import { useEffect, useState } from 'react';
import { Empty, ErrorState, formatDate, formatYuan, Loading, Notice, Panel, useData } from '@platform/shared';
import { BillingSettings } from './BillingSettings.jsx';
import { downloadCsv } from '../shared.jsx';

// 视频模型的输入画面支持方式（可多选）：一个模型可以既支持文生、也支持图生/首尾帧。
const INPUT_MODE_OPTIONS = [['TEXT', '文生视频（纯文本）'], ['FIRST_FRAME', '图生视频（首帧图）'], ['FIRST_LAST_FRAME', '首尾帧参考（首帧+尾帧）'], ['OMNI_REFERENCE', '全能参考（多图/多视频/多音频）']];
// 音乐的生成模式（可多选）：歌词生音乐 / 描述生音乐（描述模式由平台先用文本模型代写歌词）
const MUSIC_MODE_OPTIONS = [['LYRICS', '歌词生音乐'], ['DESCRIPTION', '描述生音乐']];

// 四个模态只有一份清单（原来路由和合同单价各写了一份、顺序还不一样 —— 同一件事两套写法正是这次要清的乱）。
const MODALITIES = [['TEXT', '文本'], ['IMAGE', '图片'], ['VIDEO', '视频'], ['MUSIC', '音乐']];

/**
 * 上游合同单价（P90）：与上游签的合同价，用来把「用量证据」自动折算成实际计费（来源 COMPUTED）。
 *
 * 结构必须与后端 `services/upstreamCost.js` 的 `normalizeUpstreamUnitPrices` 一模一样（**不要**在这里另发明一种）：
 *   { TEXT:{inputFenPer1MTokens,outputFenPer1MTokens},
 *     IMAGE:{perImageFen,byResolution:{'1K':30}},
 *     VIDEO:{perSecondFen,byResolution,audioExtraPerSecondFen},
 *     MUSIC:{perCallFen,perSecondFen} }
 * 金额一律「非负整数分」；留空 = 这一项没配单价（折算不出来 → UNKNOWN，**绝不按 0 计**）。
 * ⚠️ 文本的单位是**分 / 百万 token**（2026-09-15 改，原来按「分 / 千 token」）。
 *    上游价目表一般写「元 / 百万 token」：deepseek-flash 输入 2 元、输出 8 元
 *    → 分/百万 = 200 / 800，正好整数；换成「分/千」就是 0.2 / 0.8，**填不进去**。
 * 两层：本渠道共用价（channel.upstreamUnitPrices，按渠道 + 素材类型共用）
 *      + 模型级覆盖（channel.modelUnitPrices = { [modelId]: { [素材类型]: {…} } }），
 * 优先级 **模型 > 素材类型**（逐字段回退），模型级留空即回落共用价。
 * 分模态的计价单位**原样保留**：TEXT 分/百万 token、IMAGE 分/张、VIDEO 分/秒、MUSIC 分/次。
 */
const UNIT_PRICE_FIELDS = {
  TEXT: [['inputFenPer1MTokens', '输入（分 / 百万 token）'], ['outputFenPer1MTokens', '输出（分 / 百万 token）']],
  IMAGE: [['perImageFen', '每张（分）']],
  VIDEO: [['perSecondFen', '每秒（分）'], ['audioExtraPerSecondFen', '含音频每秒加价（分）']],
  MUSIC: [['perCallFen', '每次（分）'], ['perSecondFen', '每秒（分）']],
};
const UNIT_PRICE_TIER_SUGGESTIONS = { IMAGE: ['1K', '2K', '4K'], VIDEO: ['480p', '720p', '1080p', '2K', '4K'] };
// 毛利列用哪个字段当「成本价」：一个模型只有一个主计价项时才算得出来。
// 文本按 token 计（输入/输出两档），折算不出"单次成本"，所以文本行不显示毛利（不猜）。
const PRIMARY_COST_FIELD = { IMAGE: 'perImageFen', VIDEO: 'perSecondFen', MUSIC: 'perCallFen' };

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

// 音乐的生成模式：留空＝两种都支持
function musicModesOf(declared) {
  const value = declared?.modes;
  if (!Array.isArray(value) || !value.length) return ['LYRICS', 'DESCRIPTION'];
  return value.map((item) => String(item ?? '').trim().toUpperCase()).filter((item) => MUSIC_MODE_OPTIONS.some(([key]) => key === item));
}

// 输入框要能一边打字一边留住逗号/空格：直接拿解析后的数组回填，逗号会被立刻吃掉，
// 表现成「只能填一个值」。所以编辑期间先存草稿文本，失焦后再回到规范化后的显示。
const capabilityText = (value) => (Array.isArray(value) ? value.join(', ') : '');
const parseCapabilityText = (text) => String(text || '').split(/[,，\s]+/).map((value) => value.trim()).filter(Boolean);

/** 金额（分）显示：整数分原样，带小数分的补 4 位（文本一次可能只有零点几分的成本）。 */
const fenText = (value) => Number.isInteger(Number(value)) ? `${Number(value)} 分` : `${Number(value).toFixed(4)} 分`;
/** 实测单价显示：单位随模态（分/百万 token、分/张、分/秒、分/次），整数分。 */
const unitPriceText = (value, unitLabel) => `${Number(value)} ${unitLabel}`;
/** 偏差多大算"醒目"：合同价与实测差两成以上就标红（合同价填错、上游调价都会落到这里）。 */
const DEVIATION_ALERT_PERCENT = 20;
/** 实测单价的样本阈值与文案（与后端 services/measuredUnitPrices.js 的默认阈值一致）。 */
const MEASURED_MIN_SAMPLES = 3;
const INSUFFICIENT_REASON_TEXT = {
  TOO_FEW_SAMPLES: (item) => `样本不足（${item.sampleCount} 笔）`,
  NO_USAGE_IN_SNAPSHOT: (item) => `测不出来：有实扣 ${item.excluded?.noUnits ?? 0} 笔，但快照里没有用量`,
  NO_REPORTED_SAMPLES: () => '测不出来：这段时间上游没回过逐笔实扣',
};

export function AiCapabilityPanel({ api }) {
  const config = useData(() => api.get('admin/billing-config/ai-provider'), [api]);
  const pricing = useData(() => api.get('admin/compute-pricing'), [api]);
  // 实测单价（P92）：上游逐笔实扣 ÷ 用量，滚动近 N 天。**只读**，用来校价目表里的合同价。
  const [measuredDays, setMeasuredDays] = useState('30');
  const measured = useData(() => api.get(`admin/billing-config/measured-unit-prices?days=${measuredDays}`), [api, measuredDays]);
  const measuredByKey = new Map((measured.data?.items || []).map((item) => [`${item.channelId}:${item.model}:${item.modality}`, item]));
  const [form, setForm] = useState(null);
  const [perCall, setPerCall] = useState({});
  const [models, setModels] = useState({});
  const [message, setMessage] = useState('');
  // 保存结果与「测试连接 / 读取模型」的结果分开存：前者显示在页面底部的保存按钮旁（按钮就在那里），
  // 后者显示在 ① 里（动作也在那里）。混用一个 state 会让保存失败的红色提示跑到页面顶部，看不到。
  const [saveMessage, setSaveMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState('');
  const [routeSearch, setRouteSearch] = useState('');
  // 价目表：这个渠道当前在填哪个模态的价（默认取「能力路由」给它定的模态，没路由过就是文本）。
  const [priceModality, setPriceModality] = useState({});
  // 还没填金额的档位草稿 + 档位名输入框（按 渠道:模态:模型 记）。
  const [tierDrafts, setTierDrafts] = useState({});
  const [tierInput, setTierInput] = useState({});
  // 能力输入框的草稿文本（理由同上：别把用户刚敲的逗号吃掉）。
  const [capabilityDrafts, setCapabilityDrafts] = useState({});
  // 保存失败单独存一份：后端拒绝（例如合同单价填了负数）时必须显示**红色**错误，不能被当成成功提示。
  const [saveError, setSaveError] = useState('');
  const policy = config.data?.policy;
  useEffect(() => {
    if (policy) setForm({ ...policy, apiKey: '', reason: '', channels: policy.channels || [], modalityChannels: policy.modalityChannels || {} });
  }, [policy]);
  useEffect(() => {
    const value = pricing.data?.pricing;
    if (!value) return;
    setPerCall({ ...(value.perCall || {}) });
    setModels({ ...(value.models || {}) });
  }, [pricing.data]);

  function updateChannel(index, patch) { setForm({ ...form, channels: form.channels.map((item, i) => (i === index ? { ...item, ...patch } : item)) }); }
  function addChannel() {
    const id = `channel-${Date.now().toString(36)}`;
    setForm({ ...form, channels: [...form.channels, { id, name: `新渠道 ${form.channels.length + 1}`, provider: 'custom', model: '', models: [], endpoint: '', protocol: 'CHAT', modalities: [] }] });
    setOpen(id);
  }
  function removeChannel(index) {
    const id = form.channels[index].id;
    // 删渠道时顺手把「指着这条渠道」的路由一起清掉：留着的话保存会被后端拦下
    // （读图渠道必须来自已配置的渠道列表），报错落在别的字段上，很难看懂。
    setForm({
      ...form,
      channels: form.channels.filter((_, i) => i !== index),
      modalityChannels: Object.fromEntries(Object.entries(form.modalityChannels).filter(([, v]) => v !== id)),
      modalityBackupChannels: Object.fromEntries(Object.entries(form.modalityBackupChannels || {}).filter(([, v]) => v !== id)),
      visionChannelId: form.visionChannelId === id ? '' : (form.visionChannelId || ''),
      modelRoutes: (form.modelRoutes || []).filter((route) => route.channelId !== id && route.backupChannelId !== id),
    });
  }
  function channelRequest(channel) { return { endpoint: channel.endpoint, channelId: channel.id, ...(channel.apiKey ? { apiKey: channel.apiKey } : {}) }; }
  // 渠道按「能力路由」确定模态（价目表按它决定成本价的计价单位）。
  function channelModality(channelId) { return Object.entries(form?.modalityChannels || {}).find(([, id]) => id === channelId)?.[0] || ''; }
  function modalityOf(channel) { return priceModality[channel.id] || channelModality(channel.id) || 'TEXT'; }
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
  const capabilityDraftKey = (index, modelId, key) => `${index}:${modelId}:${key}`;
  function setCapabilityDraft(index, modelId, key, text) {
    setCapabilityDrafts((current) => ({ ...current, [capabilityDraftKey(index, modelId, key)]: text }));
  }
  function clearCapabilityDrafts(index, modelId) {
    const prefix = `${index}:${modelId}:`;
    setCapabilityDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix))));
  }
  function channelTemplateText(channel) {
    const modality = channelModality(channel.id);
    const custom = channel.requestTemplates?.[modality];
    if (typeof custom === 'string') return custom;
    if (custom && typeof custom === 'object') return JSON.stringify(custom, null, 2);
    const fallback = config.data?.defaultRequestTemplates?.[modality];
    return fallback ? JSON.stringify(fallback, null, 2) : '';
  }
  // ── 价目表：成本价写入（两层契约）─────────────────────────────────────────────
  //   ① 本渠道共用价：channel.upstreamUnitPrices = { [素材类型]: {…字段…} }
  //   ② 模型级覆盖：channel.modelUnitPrices = { [modelId]: { [素材类型]: {…同一套字段…} } }
  // 键名都与后端 upstreamCost.js 一致（inputFenPer1MTokens / perImageFen / perSecondFen /
  // audioExtraPerSecondFen / perCallFen / byResolution）；传 null 的键会被删掉（= 没配），绝不写成 0。
  const tierDraftKey = (index, modality, modelId = '') => `${index}:${modality}:${modelId}`;
  // 填了非法值（负数、非数字）就**原样提交**，让后端拒绝并回显原因；前端不悄悄把它当成 0 或丢掉。
  function unitPriceAmount(raw) {
    const text = String(raw).trim();
    if (text === '') return null;
    return Number.isFinite(Number(text)) ? Number(text) : text;
  }
  function compactBucket(source, patch) {
    const bucket = { ...(source || {}), ...patch };
    for (const [key, value] of Object.entries(bucket)) if (value === null || value === undefined || value === '') delete bucket[key];
    return bucket;
  }
  function patchUnitPrice(index, modality, patch) {
    const channel = form.channels[index];
    const prices = { ...(channel.upstreamUnitPrices || {}) };
    const bucket = compactBucket(prices[modality], patch);
    if (Object.keys(bucket).length) prices[modality] = bucket; else delete prices[modality];
    updateChannel(index, { upstreamUnitPrices: Object.keys(prices).length ? prices : null });
  }
  /**
   * 模型级覆盖读取：契约是 { [modelId]: {…与素材类型相同的字段…} }；
   * 若后端把它写成「按素材类型再分一层」，这里也认，否则换了形状界面上会显示成「没配」，覆盖白填。
   */
  function readModelBucket(channel, modelId, modality) {
    const raw = channel.modelUnitPrices?.[modelId];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const nested = modality ? raw[modality] : null;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) return nested;
    return raw;
  }
  function patchModelUnitPrice(index, modelId, modality, patch) {
    const channel = form.channels[index];
    const all = { ...(channel.modelUnitPrices || {}) };
    const raw = all[modelId] && typeof all[modelId] === 'object' && !Array.isArray(all[modelId]) ? all[modelId] : {};
    const nested = raw[modality] && typeof raw[modality] === 'object' && !Array.isArray(raw[modality]) ? raw[modality] : {};
    const bucket = compactBucket(nested, patch);
    // 契约是 { [modelId]: { [素材类型]: {…字段…} } }：**永远按素材类型再分一层**写 ——
    // 拍平成 { perImageFen: 30 } 的对象会被后端 normalizeModelUnitPrices 当成「这个模型没配」直接丢掉。
    if (Object.keys(bucket).length) all[modelId] = { ...raw, [modality]: bucket };
    else if (Object.keys(raw).some((key) => key !== modality)) all[modelId] = { ...raw, [modality]: {} };   // 别的素材类型的覆盖不能一起抹掉
    else delete all[modelId];
    updateChannel(index, { modelUnitPrices: Object.keys(all).length ? all : null });
  }
  function setUnitPriceValue(index, modality, field, raw) { patchUnitPrice(index, modality, { [field]: unitPriceAmount(raw) }); }
  function setUnitPriceTier(index, modality, tier, raw) {
    const byResolution = { ...(form.channels[index].upstreamUnitPrices?.[modality]?.byResolution || {}) };
    const value = unitPriceAmount(raw);
    if (value === null) delete byResolution[tier]; else byResolution[tier] = value;
    patchUnitPrice(index, modality, { byResolution: Object.keys(byResolution).length ? byResolution : null });
  }
  function setModelUnitPriceValue(index, modelId, modality, field, raw) { patchModelUnitPrice(index, modelId, modality, { [field]: unitPriceAmount(raw) }); }
  function setModelUnitPriceTier(index, modelId, modality, tier, raw) {
    const byResolution = { ...(readModelBucket(form.channels[index], modelId, modality)?.byResolution || {}) };
    const value = unitPriceAmount(raw);
    if (value === null) delete byResolution[tier]; else byResolution[tier] = value;
    patchModelUnitPrice(index, modelId, modality, { byResolution: Object.keys(byResolution).length ? byResolution : null });
  }
  function addUnitPriceTier(index, modality, modelId, tier) {
    const name = String(tier || '').trim().slice(0, 40);
    if (!name) return;
    const key = tierDraftKey(index, modality, modelId);
    setTierDrafts((current) => ({ ...current, [key]: [...new Set([...(current[key] || []), name])] }));
    setTierInput((current) => ({ ...current, [key]: '' }));
  }
  function removeUnitPriceTier(index, modality, modelId, tier) {
    const key = tierDraftKey(index, modality, modelId);
    setTierDrafts((current) => ({ ...current, [key]: (current[key] || []).filter((item) => item !== tier) }));
    const bucket = modelId ? readModelBucket(form.channels[index], modelId, modality) : form.channels[index].upstreamUnitPrices?.[modality];
    if (bucket?.byResolution?.[tier] === undefined) return;
    const byResolution = { ...bucket.byResolution };
    delete byResolution[tier];
    const next = { byResolution: Object.keys(byResolution).length ? byResolution : null };
    if (modelId) patchModelUnitPrice(index, modelId, modality, next); else patchUnitPrice(index, modality, next);
  }
  /** 成本价的金额输入框（共用价与模型级覆盖共用同一个渲染器，只有 placeholder 与写回目标不同）。 */
  function unitPriceFields(index, modality, modelId, bucket) {
    const shared = modelId ? (form.channels[index].upstreamUnitPrices?.[modality] || {}) : null;
    return <div className="form-grid">
      {(UNIT_PRICE_FIELDS[modality] || []).map(([field, label]) => <label key={field}>{label}<input type="number" min="0" step="1"
        value={bucket?.[field] ?? ''}
        placeholder={modelId ? (shared?.[field] == null ? '留空 = 用本渠道共用价（现在没配）' : `留空 = 用共用价 ${shared[field]}`) : '留空 = 未配（折算为 UNKNOWN）'}
        onChange={(event) => (modelId ? setModelUnitPriceValue(index, modelId, modality, field, event.target.value) : setUnitPriceValue(index, modality, field, event.target.value))} /></label>)}
    </div>;
  }
  function unitPriceTiers(index, modality, modelId, bucket) {
    const configured = Object.keys(bucket?.byResolution || {});
    const key = tierDraftKey(index, modality, modelId);
    const suggestions = UNIT_PRICE_TIER_SUGGESTIONS[modality] || [];
    const drafts = tierDrafts[key] || [];
    if (!suggestions.length && !configured.length && !drafts.length) return null;
    const tiers = [...new Set([...suggestions, ...configured, ...drafts])];
    return <details className="top-gap"><summary>分辨率档位价（可选{configured.length ? `，已配 ${configured.length} 档` : ''}）</summary>
      <div className="muted">配了这一档就以档位价为准；档位没配或拿不到分辨率时回落到上面的单价，仍折算不出来就保持 UNKNOWN（不按 0）。</div>
      <div className="form-grid top-gap">
        {tiers.map((tier) => <label key={tier}>{tier}<span className="row-actions"><input type="number" min="0" step="1" value={bucket?.byResolution?.[tier] ?? ''} placeholder="分" onChange={(event) => (modelId ? setModelUnitPriceTier(index, modelId, modality, tier, event.target.value) : setUnitPriceTier(index, modality, tier, event.target.value))} /><button type="button" className="text-button" onClick={() => removeUnitPriceTier(index, modality, modelId, tier)}>删除</button></span></label>)}
      </div>
      <label className="top-gap">新增分辨率档位（输入后回车）<input value={tierInput[key] || ''} placeholder="例如：512p" onChange={(event) => setTierInput((current) => ({ ...current, [key]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addUnitPriceTier(index, modality, modelId, event.target.value); } }} /></label>
    </details>;
  }
  /**
   * 模型能力编辑器：只显示该模态真正有意义的字段（文本没有比例清晰度，就整格显示「无参数」）。
   * 输入框只显示「已声明」的值，模态默认值放 placeholder —— 默认值不代表该模型的真实能力。
   */
  function capabilityFields(index, modality, modelId) {
    const channel = form.channels[index];
    const declared = channel.modelCapabilities?.[modelId] || {};
    const defaults = config.data?.capabilityDefaults?.[modality] || {};
    const isVideo = modality === 'VIDEO';
    const isMusic = modality === 'MUSIC';
    const field = (label, key, placeholder) => {
      const draft = capabilityDrafts[capabilityDraftKey(index, modelId, key)];
      return <label>{label}<input
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
    if (!isVideo && !isMusic && modality !== 'IMAGE') return <span className="muted">—（文本模态没有比例 / 清晰度 / 时长这类参数，无需配置）</span>;
    const hint = (channel.modelMappings || []).find((item) => String(item.id || item.model) === modelId)?.capabilities;
    return <>
      <div className="muted">这些是「原样发给上游的取值」，平台无法自动识别（多数上游的 /models 只返回模型 ID）。只填该模型确实支持的取值，多个用逗号分隔；留空＝不声明，课时里回落到模态默认值。</div>
      <div className="row-actions top-gap">{Object.keys(declared).length ? <button type="button" className="text-button" onClick={() => clearModelCapability(index, modelId)}>清空声明</button> : <span className="muted">未声明（用默认值）</span>}{hint ? <button type="button" className="text-link-button" onClick={() => { clearCapabilityDrafts(index, modelId); updateModelCapability(index, modelId, hint); }}>用上游返回的能力填充</button> : null}</div>
      <div className="form-grid top-gap">
        {modality === 'IMAGE' || isVideo ? field('比例', 'aspectRatios', '16:9, 9:16') : null}
        {modality === 'IMAGE' || isVideo ? field('清晰度', 'resolutions', isVideo ? '480p, 720p' : '1k, 2k') : null}
        {isVideo ? field('时长（秒）', 'durations', '5, 10') : null}
        {isVideo ? <label className="checkbox-label">支持生成音频<input type="checkbox" checked={declared.audio === true} onChange={(event) => updateModelCapability(index, modelId, { audio: event.target.checked })} /></label> : null}
        {isMusic ? <label>默认曲风（歌词模式下上游要求曲风必填，学生只写词时用这个）<input value={declared.defaultStyle || ''} placeholder="例如：适合儿童的中文流行歌曲，旋律明亮温暖" onChange={(event) => updateModelCapability(index, modelId, { defaultStyle: event.target.value })} /></label> : null}
        {isMusic ? <label>生成模式（不选＝两种都支持）<span className="capability-modes">{MUSIC_MODE_OPTIONS.map(([value, label]) => <span key={value}><input type="checkbox" checked={musicModesOf(declared).includes(value)} onChange={(event) => { const current = musicModesOf(declared); const next = event.target.checked ? [...new Set([...current, value])] : current.filter((item) => item !== value); updateModelCapability(index, modelId, { modes: next }); }} />{label}</span>)}</span></label> : null}
        {isVideo ? <label>输入画面（可多选，不选＝按模型名自动判断）<span className="capability-modes">{INPUT_MODE_OPTIONS.map(([value, label]) => <span key={value}><input type="checkbox" checked={inputModesOf(declared, modelId).includes(value)} onChange={(event) => { const current = inputModesOf(declared, modelId); const next = event.target.checked ? [...new Set([...current, value])] : current.filter((item) => item !== value); updateModelCapability(index, modelId, { inputModes: next, inputFrame: undefined }); }} />{label}</span>)}</span></label> : null}
      </div>
    </>;
  }
  async function testChannel(channel) { setBusy(true); setMessage(''); try { const result = await api.post('admin/billing-config/ai-provider/test', channelRequest(channel)); setMessage(`${channel.name}：${result.message || '连接成功'}`); } catch (e) { setMessage(`${channel.name}：${e.message || '连接失败'}`); } finally { setBusy(false); } }
  async function fetchModels(channel, index) { setBusy(true); setMessage(''); try { const result = await api.post('admin/billing-config/ai-provider/models', channelRequest(channel)); updateChannel(index, { modelMappings: result.items || [] }); setMessage(`${channel.name}：已读取 ${result.items?.length || 0} 个模型，请勾选本渠道可用模型`); } catch (e) { setMessage(e.message || '获取模型失败'); } finally { setBusy(false); } }
  /**
   * 「用当前渠道试一次」：把这套（可能还没保存的）渠道配置真发一次最小请求。
   * 只验证「上游认不认这套参数」，不扣学生额度，上游可能计费。
   * 刻意**不要求先保存** —— 目的就是在保存前当场知道参数行不行。
   */
  async function probeChannel(channel, modality) {
    if (!window.confirm(`试一次 ${modality} 会向上游提交真实生成并可能计费，等待时间取决于模态。继续？`)) return;
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
  // 对外价：只送非负整数分；留空的模型回落到模态基础价。空输入不提交。
  const cleanPrices = (map) => Object.fromEntries(Object.entries(map)
    .filter(([, value]) => value !== '' && value !== null && Number.isFinite(Number(value)))
    .map(([key, value]) => [key, Number(value)]));
  const setModelPrice = (model, raw) => setModels((current) => {
    const next = { ...current };
    if (raw === '') delete next[model]; else next[model] = Number(raw);
    return next;
  });
  /**
   * 一次保存，两处 PUT（用户口径：改动"各自 PUT 回去"）。
   * 渠道 / 路由 / 合同单价都在同一份 ai-provider 策略里，所以一次请求就够；
   * 对外价是另一个接口（admin/compute-pricing），单独再 PUT 一次。
   * 拆两次的好处：ai-provider 被后端拒绝时**不会**半截把对外价写进去。
   */
  async function save(event) {
    event.preventDefault(); setBusy(true); setSaveMessage(''); setSaveError('');
    try {
      await api.put('admin/billing-config/ai-provider', form);
    } catch (e) {
      setSaveError(`${e.message || '保存失败'}${e.code ? `（${e.code}）` : ''}`);
      setBusy(false);
      return;
    }
    try {
      await api.put('admin/compute-pricing', { perCall: cleanPrices(perCall), models: cleanPrices(models) });
      setSaveMessage('已保存：渠道 · 价目表（成本价与对外价）· 路由与开关。后续请求立即使用新配置；在途请求保留原路由。');
      config.refresh(); pricing.refresh();
    } catch (e) {
      setSaveError(`渠道、价目表成本价与路由已保存，但对外价保存失败：${e.message || '未知原因'}`);
    } finally { setBusy(false); }
  }
  if (config.loading || pricing.loading) return <Panel title="渠道与价格"><Loading label="正在读取渠道与配置…" /></Panel>;
  if (config.error || pricing.error) return <Panel title="渠道与价格"><ErrorState error={config.error || pricing.error} onRetry={() => { config.refresh(); pricing.refresh(); }} /></Panel>;
  if (!form) return <Panel title="渠道与价格"><Loading label="正在读取渠道与配置…" /></Panel>;

  // ── 价目表的分组：渠道（每组自带模型清单）+ 未归属渠道的历史定价（否则那些对外价改不掉、也看不见）──
  const channels = form.channels || [];
  const assigned = new Set(channels.flatMap((channel) => [...(channel.models || []), channel.model].filter(Boolean)));
  const priceGroups = [
    ...channels.map((channel, index) => ({ id: channel.id, index, channel, name: channel.name || channel.id, models: [...new Set([...(channel.models || []), channel.model].filter(Boolean))] })),
    { id: '__unassigned__', index: -1, channel: null, name: '其他模型（不在任何渠道里）', models: Object.keys(models).filter((model) => !assigned.has(model)) },
  ].filter((group) => group.models.length);

  /**
   * 「采纳为成本价」（P92）：把**实测单价**写进该模型的合同单价（模型级覆盖），
   * 走现有保存路径 `PUT admin/billing-config/ai-provider` —— 不另造写接口，也不在服务端自动写。
   * 这是这个页面唯一的「实测 → 配置」动作，且**必须由人点击**触发（实测只用来校，不自动改价）。
   * 与页面底部的「保存全部配置」同一条路径，所以会连同本页当前（未保存）的改动一起提交。
   */
  async function adoptMeasuredPrice(index, model, modality, item) {
    const channel = form.channels[index];
    const suggested = item?.suggestedUnitPrices;
    if (!channel || !suggested || !Object.keys(suggested).length) return;
    const text = Object.entries(suggested).map(([field, value]) => `${field} = ${value} 分`).join('，');
    if (!window.confirm(`把实测单价写进「${channel.name || channel.id} / ${model}」的合同成本价？\n\n写入：${text}\n（实测 ${item.sampleCount} 笔 / 近 ${measuredDays} 天，只算上游逐笔实扣）${item.suggestNote ? `\n说明：${item.suggestNote}` : ''}\n\n会连同本页当前未保存的改动一起提交。`)) return;
    const all = { ...(channel.modelUnitPrices || {}) };
    const raw = all[model] && typeof all[model] === 'object' && !Array.isArray(all[model]) ? all[model] : {};
    const nested = raw[modality] && typeof raw[modality] === 'object' && !Array.isArray(raw[modality]) ? raw[modality] : {};
    // 契约是 { [modelId]: { [素材类型]: {…字段…} } }：只补这几个字段，别的档位价/字段原样保留。
    all[model] = { ...raw, [modality]: compactBucket(nested, suggested) };
    const next = { ...form, channels: form.channels.map((item2, i) => (i === index ? { ...item2, modelUnitPrices: all } : item2)) };
    setForm(next);
    setBusy(true); setSaveError(''); setSaveMessage('');
    try {
      await api.put('admin/billing-config/ai-provider', next);
      setSaveMessage(`已采纳实测单价：${model} 的合同成本价写入 ${text}。`);
      config.refresh(); measured.refresh();
    } catch (error) {
      setSaveError(`采纳实测单价失败：${error.message || '未知原因'}${error.code ? `（${error.code}）` : ''}`);
    } finally { setBusy(false); }
  }

  /** 实测（近 N 天）单元格：实测单价 + 与合同价的偏差；样本不足时说清"为什么没有数"。 */
  function measuredCell(index, channel, model, modality) {
    if (!channel) return <span className="muted">—（不在任何渠道里，没有实测）</span>;
    if (measured.error) return <span className="muted">读取失败：{measured.error.message || '未知原因'}</span>;
    if (!measured.data) return <span className="muted">读取中…</span>;
    const item = measuredByKey.get(`${channel.id}:${model}:${modality}`);
    if (!item) return <span className="muted">暂无样本（近 {measuredDays} 天没有上游逐笔实扣）</span>;
    const excluded = Object.entries(item.excluded?.bySource || {}).filter(([, count]) => count > 0);
    const excludedText = excluded.length ? `另有 ${excluded.map(([source, count]) => `${count} 笔 ${source}`).join('、')}未计入` : '';
    if (item.measuredUnitPrice === null || item.measuredUnitPrice === undefined) {
      const reason = (INSUFFICIENT_REASON_TEXT[item.insufficientReason] || INSUFFICIENT_REASON_TEXT.NO_REPORTED_SAMPLES)(item);
      return <div className="muted">{reason}<div>{excludedText}</div></div>;
    }
    const deviation = item.deviationPercent;
    const alert = deviation !== null && Math.abs(deviation) >= DEVIATION_ALERT_PERCENT;
    return <div>
      <strong>{unitPriceText(item.measuredUnitPrice, item.unitLabel)}</strong>
      <div className={alert ? 'danger-text' : 'muted'}>
        {item.contract.configured
          ? `合同价 ${item.contract.comparableUnitPrice === null ? '算不出来' : unitPriceText(item.contract.comparableUnitPrice, item.unitLabel)}${deviation === null ? '' : ` · 偏差 ${deviation > 0 ? '+' : ''}${deviation}%`}`
          : '合同价未配（成本折算现在是 UNKNOWN）'}
      </div>
      <div className="muted">{item.sampleCount} 笔 · {excludedText}</div>
      {item.suggestedUnitPrices ? <button type="button" className="secondary-button top-gap" disabled={busy} title={item.suggestNote || ''} onClick={() => adoptMeasuredPrice(index, model, modality, item)}>采纳为成本价</button> : null}
      {!item.suggestedUnitPrices && item.suggestNote ? <div className="muted">{item.suggestNote}</div> : null}
    </div>;
  }

  /** ② 一行 = 渠道 × 模型：成本价、实测、对外价并排，外加只展示的毛利与折叠的能力。 */
  function priceRows(group) {
    const { channel, index } = group;
    const modality = channel ? modalityOf(channel) : '';
    const sharedBucket = channel ? (channel.upstreamUnitPrices?.[modality] || {}) : {};
    const primaryField = PRIMARY_COST_FIELD[modality];
    return <tbody key={group.id}>
      {channel ? <tr>
        <td colSpan={6}>
          <div className="row-actions"><strong>{group.name}</strong>
            <label>计价模态<select value={modality} onChange={(event) => setPriceModality((current) => ({ ...current, [channel.id]: event.target.value }))}>{MODALITIES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            {channelModality(channel.id) !== modality ? <span className="muted">（能力路由现在给这条渠道定的是「{MODALITIES.find(([id]) => id === channelModality(channel.id))?.[1] || '未路由'}」）</span> : <span className="muted">（来自能力路由）</span>}
          </div>
          <div className="top-gap"><strong>本渠道共用价（素材类型价）</strong>（这几行的成本价留空时就回落到它）</div>
          {unitPriceFields(index, modality, '', sharedBucket)}
          {unitPriceTiers(index, modality, '', sharedBucket)}
        </td>
      </tr> : <tr><td colSpan={6}><strong>{group.name}</strong><span className="muted"> · 不在任何渠道的模型清单里，只有对外价（历史遗留；要清掉就把对外价清空）</span></td></tr>}
      {group.models.map((model) => {
        const modelBucket = channel ? (readModelBucket(channel, model, modality) || {}) : null;
        const costFen = primaryField ? (modelBucket?.[primaryField] ?? sharedBucket?.[primaryField]) : null;
        const saleFen = models[model] ?? perCall[modality];
        const marginFen = (costFen == null || saleFen == null) ? null : Number(saleFen) - Number(costFen);
        return <tr key={model}>
          <td><strong>{model}</strong>{channel?.model === model ? <div className="muted">渠道默认模型</div> : null}</td>
          <td>{channel ? <>{unitPriceFields(index, modality, model, modelBucket)}{unitPriceTiers(index, modality, model, modelBucket)}</> : <span className="muted">—</span>}</td>
          <td>{measuredCell(index, channel, model, modality)}</td>
          <td>
            <input type="number" min="0" step="1" value={models[model] ?? ''} placeholder={perCall[modality] == null ? (channel ? '留空 = 模态基础价未配' : '留空 = 用该模态的基础价') : `留空 = 模态基础价 ${perCall[modality]} 分`} onChange={(event) => setModelPrice(model, event.target.value)} />
            <div className="muted">只用于统计，不扣学生、不计收入、不是上游成本</div>
          </td>
          <td>{!channel ? <span className="muted">—（不在任何渠道里，没有成本价可比）</span> : (primaryField == null ? <span className="muted">—（文本按 token 计价，折算不出单次毛利）</span> : (marginFen == null ? <span className="muted">成本价或对外价还没配</span> : <strong className={marginFen < 0 ? 'danger-text' : ''}>{fenText(marginFen)}</strong>))}</td>
          <td>{channel ? (['IMAGE', 'VIDEO', 'MUSIC'].includes(modality)
            ? <details><summary>{Object.keys(channel.modelCapabilities?.[model] || {}).length ? '已声明（点开改）' : '未声明（用默认值）'}</summary>{capabilityFields(index, modality, model)}</details>
            : <span className="muted">—</span>) : <span className="muted">—</span>}</td>
        </tr>;
      })}
    </tbody>;
  }

  return <>
    <form onSubmit={save}>
      <Panel title="① 渠道（怎么连上游）">
        <Notice tone="warning">渠道只负责「连哪家上游」：名称 / 调用地址 / 可用模型 / 默认模型 + 密钥。
          <strong>模型单价与能力都在下面的价目表里填</strong>（一个模型只填一次）。「测试连接」只探接口可达；
          「用当前渠道试一次」会发起真实生成、可能运行数分钟并产生上游费用。</Notice>
        {message ? <Notice tone={message.includes('失败') || message.includes('错误') ? 'danger' : 'success'}>{message}</Notice> : null}
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
              <label className="span-2">可用模型（勾选本渠道提供的模型）</label>
              <div className="channel-model-list span-2">
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
              <label>供应商账户标识<input value={channel.providerAccountRef || ''} onChange={(e) => updateChannel(index, { providerAccountRef: e.target.value })} placeholder="上游账户/合同编号，留个记号" /></label>
              <label>API Key<input type="password" value={channel.apiKey || ''} onChange={(e) => updateChannel(index, { apiKey: e.target.value })} placeholder="留空保持原密钥" autoComplete="new-password" /></label>
            </div>
            <details className="top-gap"><summary>高级配置</summary>
              <div className="form-grid top-gap">
                <span className="muted">接口协议固定为 Chat Completions（兼容 OpenAI 形状）。配置里已存的 protocol 字段保留但暂不使用 —— 等真支持多协议时再接上适配器。</span>
                <label>手动添加模型 ID<input onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value.trim(); if (v) { updateChannel(index, { models: [...new Set([...(channel.models || []), v])] }); e.target.value = ''; } } }} placeholder="输入后回车添加" /></label>
              </div>
              {channelModality(channel.id) ? <details className="top-gap"><summary>请求模板</summary><div className="muted">仅在供应商要求特殊请求格式时配置；留空使用平台默认模板。</div><textarea rows={6} value={channelTemplateText(channel)} onChange={(e) => updateChannel(index, { requestTemplates: { ...(channel.requestTemplates || {}), [channelModality(channel.id)]: e.target.value } })} /></details> : null}
            </details>
            <div className="row-actions top-gap"><button type="button" className="secondary-button" disabled={busy} onClick={() => testChannel(channel)}>测试连接</button><button type="button" className="secondary-button" disabled={busy} onClick={() => probeChannel(channel, channelModality(channel.id) || 'TEXT')}>用当前渠道试一次</button><button type="button" className="secondary-button" disabled={busy} onClick={() => fetchModels(channel, index)}>读取模型</button></div>
          </> : null}
        </div>)}
      </Panel>

      {/* ② 价目表：取代原来散落的「上游合同单价」+「上游估算成本」+「逐模型估算成本」+「对外售价」四处定价。 */}
      <Panel title="② 价目表（每行 = 渠道 × 模型）" actions={<><select value={measuredDays} onChange={(event) => setMeasuredDays(event.target.value)} title="实测单价统计窗口"><option value="7">实测：近 7 天</option><option value="30">实测：近 30 天</option><option value="90">实测：近 90 天</option></select><button type="button" className="secondary-button" disabled={pricing.loading} onClick={() => { config.refresh(); pricing.refresh(); measured.refresh(); }}>刷新</button></>}>
        <Notice tone="info">这是<strong>唯一</strong>填价格的地方。<strong>成本价</strong>＝与上游签的合同价（单位随模态：文本分/百万 token、图片分/张、视频分/秒、音乐分/次），
          平台按用量证据自动折算上游计费（来源 <b>COMPUTED</b>），但<strong>不等于供应商开出的最终账单</strong>；<strong>对外价</strong>只用于统计「这次调用对外值多少」，
          <strong>不扣学生、不计收入、不是上游成本</strong>。留在库里没配的项一律折算为 <b>UNKNOWN</b>，绝不按 0 计。毛利列只是把两个数相减给你看，不参与任何计算。
          成本价两层：模型级覆盖 &gt; 素材类型价；模型级覆盖（留空 = 用素材类型价）。
          <br /><strong>实测（近 {measuredDays} 天）＝ 上游逐笔实回扣金额 ÷ 用量</strong>，滚动近 {measuredDays} 天；
          <strong>只统计上游逐笔回报的实扣</strong>（cost_source=REPORTED），<strong>不含我们自己按合同价折算的</strong>（COMPUTED）——
          否则就是拿自己的假设验证自己，偏差永远是 0。样本不足（少于 {MEASURED_MIN_SAMPLES} 笔，或快照里取不到用量）时<strong>不给数</strong>，
          只显示「样本不足（N 笔）」。实测只是给你校价用的，<strong>不会自动改价</strong>；要写进合同价，点那一行的「采纳为成本价」（仍走本页的保存路径，由你决定）。</Notice>
        {!priceGroups.length ? <div className="muted top-gap">还没有渠道和模型：先在 ① 里加一条渠道并勾选可用模型，价目表就会按「渠道 × 模型」列出来。</div> : <div className="table-wrap top-gap"><table>
          <thead><tr><th>模型</th><th>成本价（与上游合同价 · 用于自动折算实际计费）</th><th>实测（近 {measuredDays} 天）</th><th>对外价（仅统计）</th><th>毛利（对外价 − 成本价）</th><th>能力（决定课时里能选什么）</th></tr></thead>
          {priceGroups.map((group) => priceRows(group))}
        </table></div>}
        <details className="top-gap"><summary>模态基础价（没有单独定价的模型按它算，单位：分 / 次）</summary>
          <div className="muted">对外价留空的模型回落到这里；留空表示这个模态没配对外价，报表里会显示「未知」而不是 0。</div>
          <div className="form-grid top-gap">{MODALITIES.map(([id, name]) => <label key={id}>{name}<input type="number" min="0" step="1" value={perCall[id] ?? ''} onChange={(event) => setPerCall({ ...perCall, [id]: event.target.value === '' ? '' : Number(event.target.value) })} /></label>)}</div>
        </details>
        {pricing.data?.pricing?.updatedAt ? <div className="muted top-gap">对外价上次更新 {formatDate(pricing.data.pricing.updatedAt)}</div> : null}
      </Panel>

      {/* ③ 路由与开关：把原来散在「能力路由 / 平台路由策略 / 高级：算力网关与能力总开关」三处的全局配置合成一块。
          「算力网关」（new-api）整块 UI 已删 —— 生产未启用，留在页面上只会让人以为要配。 */}
      <Panel title="③ 路由与开关（用哪个渠道）">
        <Notice tone="info">平台按这里选渠道：精确路由（按模型）&gt; 模态主渠道 &gt; 默认渠道。主渠道被上游<strong>明确拒绝</strong>（认证失败、接口不存在、限流）时切到备用渠道；
          已输出、已受理或结果未知<strong>不自动重试</strong>。这里的所有改动都在页面底部的「保存全部配置」里一起保存。</Notice>
        <div className="row-actions top-gap"><strong>能力路由</strong><span className="muted">留空＝用默认渠道（第一条不空的路由规则）</span></div>
        <div className="form-grid top-gap">{MODALITIES.map(([id, name]) => <div key={id}><label>{name} · 主渠道<select value={form.modalityChannels[id] || ''} onChange={e => setForm({ ...form, modalityChannels: { ...form.modalityChannels, [id]: e.target.value } })}><option value="">使用默认渠道</option>{form.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>{name} · 备用渠道<select value={form.modalityBackupChannels?.[id] || ''} onChange={e => setForm({ ...form, modalityBackupChannels: { ...(form.modalityBackupChannels || {}), [id]: e.target.value } })}><option value="">不配置备用渠道</option>{form.channels.filter(c => c.id !== form.modalityChannels[id]).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>)}</div>
        {/* 读图渠道（2026-09-16）：学生端 dsh 里带图的请求走哪条渠道。
            **留空就是跟着上面的文本渠道走**（默认，也是常态：我们的模型本来就能看图）；
            只有想把图单独送去另一条渠道（比如换了便宜/更会看图的模型）时才配它。 */}
        <div className="form-grid top-gap">
          <label>读图渠道（留空＝跟着文本渠道的模型走）<select value={form.visionChannelId || ''} onChange={e => setForm({ ...form, visionChannelId: e.target.value })}><option value="">跟着文本渠道走（默认）</option>{form.channels.map(c => <option key={c.id} value={c.id}>{c.name}（{c.model}）</option>)}</select></label>
          <div className="muted">学生端发图默认交给文本渠道那个模型去读（费用照常进算力账）。只有要把图单独送到另一条渠道时才在这里选；选了的渠道被删除时，这里会自动清回默认。</div>
        </div>
        <details className="top-gap"><summary>按模型指定渠道（可选 · 现在有 {(form.modelRoutes || []).length} 条）</summary>
          <p className="muted">只有「同一个模态里，个别模型要走别的渠道」时才需要配。优先级高于上面的模态主渠道；只有上游明确拒绝且尚未产出结果时才切备用。</p>
          <label className="top-gap">搜索渠道或模型<input value={routeSearch} onChange={(event) => setRouteSearch(event.target.value)} placeholder="输入名称或模型 ID" /></label>
          {(form.modelRoutes || []).map((route, index) => {
            const patch = value => setForm({ ...form, modelRoutes: form.modelRoutes.map((item, i) => i === index ? { ...item, ...value } : item) });
            const matches = (value) => !routeSearch.trim() || String(value || '').toLowerCase().includes(routeSearch.trim().toLowerCase());
            const channelOptions = (selectedId) => form.channels.filter((channel) => channel.id === selectedId || matches(channel.name) || matches(channel.id) || (channel.models || []).some(matches));
            const modelOptions = (channelId, selectedModel) => [...new Set(form.channels.find(c => c.id === channelId)?.models || [])].filter((model) => model === selectedModel || matches(model));
            return <div className="form-grid top-gap" key={index}>
              <label>能力<select value={route.modality} onChange={e => patch({ modality: e.target.value })}>{MODALITIES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
              <label>调用渠道<select value={route.channelId} onChange={e => patch({ channelId: e.target.value, model: '' })}><option value="">选择渠道</option>{channelOptions(route.channelId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label>用户可选模型<select value={route.model} onChange={e => patch({ model: e.target.value })}><option value="">选择模型</option>{modelOptions(route.channelId, route.model).map(m => <option key={m}>{m}</option>)}</select></label>
              <label>故障备用渠道<select value={route.backupChannelId || ''} onChange={e => patch({ backupChannelId: e.target.value, backupModel: '' })}><option value="">不自动切换</option>{channelOptions(route.backupChannelId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label>故障备用模型<select disabled={!route.backupChannelId} value={route.backupModel || ''} onChange={e => patch({ backupModel: e.target.value })}><option value="">选择模型</option>{modelOptions(route.backupChannelId, route.backupModel).map(m => <option key={m}>{m}</option>)}</select></label>
              <button type="button" className="secondary-button" onClick={() => setForm({ ...form, modelRoutes: form.modelRoutes.filter((_, i) => i !== index) })}>删除策略</button>
            </div>;
          })}
          <button type="button" className="secondary-button top-gap" onClick={() => setForm({ ...form, modelRoutes: [...(form.modelRoutes || []), { modality: 'TEXT', channelId: '', model: '', backupChannelId: '', backupModel: '' }] })}>添加路由策略</button>
        </details>
        <label className="checkbox-label top-gap"><input type="checkbox" checked={Boolean(form.allowStudentExternalContent)} onChange={e => setForm({ ...form, allowStudentExternalContent: e.target.checked })} />允许学生创作内容发送到外部 AI 服务</label>
        {/* 四个模态的平台级总开关（BillingSettings）。它自带「变更原因」与独立保存按钮，所以不并进下面那次保存。 */}
        <BillingSettings api={api} embedded />
      </Panel>

      {/* 保存结果就放在保存按钮旁边（保存失败的红色提示必须在同一个视野里）。
          注：断言 p88 要求「保存失败：{saveError}」这一段原样存在 —— 后端拒绝非法合同单价时必须展示错误。 */}
      {saveError ? <Notice tone="danger">保存失败：{saveError}。修正后重试（合同单价必须是「非负整数分」，留空表示没配）。</Notice> : null}
      {saveMessage ? <Notice tone={saveMessage.includes('失败') ? 'danger' : 'success'}>{saveMessage}</Notice> : null}
      <div className="row-actions top-gap">
        <button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存全部配置（渠道 · 价目表 · 路由与开关）'}</button>
        <span className="muted">一次保存会写两处：渠道 / 价目表成本价 / 路由与开关 走 AI 渠道配置，对外价走对外价配置。模态总开关在 ③ 里单独保存。</span>
      </div>
    </form>
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
        <strong>{report.data?.totals?.activeOrgCount ?? 0}</strong> 家，学生消耗 <strong>{formatYuan(report.data?.totals?.saleFen || 0)}</strong>、我们的成本 <strong>{formatYuan(report.data?.totals?.costFen || 0)}</strong>、
        {report.data?.totals?.calls ?? 0} 次调用。学生消耗 = 对外售价合计（只计成功尝试）；我们的成本只算**已知**的部分，有未知就显示未知。点机构名看它下面每个学员。
      </p>
      <div className="split">
        <div>
          <h4>机构（近 {days} 天消耗）</h4>
          <div className="table-wrap"><table><thead><tr><th>机构</th><th>学生消耗（对外售价）</th><th>我们的成本</th><th>差额</th><th>学员</th><th>调用</th></tr></thead><tbody>
            {orgs.length ? orgs.map((item) => <tr key={item.id} className={item.id === orgId ? 'is-selected' : undefined}>
              <td><button type="button" className="link-button" onClick={() => setOrgId(item.id === orgId ? '' : item.id)}>{item.name}</button>
                <div className="muted">{item.status}{item.calls ? '' : ' · 这段时间没消耗'}</div></td>
              <td><strong>{formatYuan(item.saleFen)}</strong></td>
              <td>{item.costFen == null ? '未知' : formatYuan(item.costFen)}</td>
              <td>{item.costFen == null ? '—' : formatYuan(item.saleFen - item.costFen)}</td>
              <td>{item.studentCount}</td>
              <td className="muted">{item.calls}</td>
            </tr>) : <tr><td colSpan="6"><Empty title="还没有机构" /></td></tr>}
          </tbody></table></div>
        </div>
        <div>
          <h4>{selected ? `${selected.name} · 每个学员：学生消耗 vs 我们的成本` : '选一家机构看学员明细'}</h4>
          {!selected ? <Empty title="还没有选机构" body="点左边任意一家机构，这里会列出它下面每个学员的消耗、涉及课包数和最近一次调用时间。" />
            : students.length ? <div className="table-wrap"><table><thead><tr><th>学员</th><th>调用</th><th>学生消耗（对外售价）</th><th>我们的成本</th><th>差额</th><th>课包</th><th>最近一次</th></tr></thead><tbody>
              {students.map((item) => <tr key={item.id}>
                <td><strong>{item.name}</strong><div className="muted">{item.login}</div></td>
                <td>{item.calls}</td>
                <td><strong>{formatYuan(item.saleFen)}</strong></td>
                <td>{item.costFen == null ? '未知' : formatYuan(item.costFen)}</td>
                <td>{item.costFen == null ? '—' : formatYuan(item.saleFen - item.costFen)}</td>
                <td>{item.seriesCount}</td>
                <td className="muted">{item.lastAt ? formatDate(item.lastAt) : '—'}</td>
              </tr>)}
            </tbody></table></div> : <Empty title="这家机构这段时间没有消耗" body="换个时间范围，或确认学员是否已经用上 AI。" />}
        </div>
      </div>
    </>}
  </Panel>;
}
