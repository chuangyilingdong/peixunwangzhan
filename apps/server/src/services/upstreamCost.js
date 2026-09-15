// P90 合同单价 → 逐笔自动上游计费
//
// 口径（与产品约定一致，别在别处再抄一遍）：
//   · 文本：上游 input/output tokens × 每千 token 合同价（分/千 token）；
//   · 图片：张数（本平台每次调用 1 张）× 每次价，或按分辨率档位价；
//   · 视频：请求参数秒数 × 每秒价（可用分辨率档位价、含音频档位价）；
//   · 音乐：按次价（配了每秒价且拿得到时长时按时长折算）。
//   · **缺用量或缺单价 → null（UNKNOWN），绝不按 0 计**。
//
// 选价优先级：**模型级覆盖（modelUnitPrices）> 素材类型级（upstreamUnitPrices）> null**。
// 同一个渠道里不同模型合同价可能差十倍（qwen-turbo vs qwen-max），所以模型级覆盖必须有；
// 命中的层级会写进 cost_rule_snapshot.priceLevel（MODEL|MODALITY）供对账按模型核对。
//
// 金额单位：分（整数）。折算按四舍五入（Math.round），每一档单独取整后相加，
// 这样同样的输入永远得到同样的整数结果，守卫能断言精确值。
//
// 来源优先级：REPORTED > COMPUTED > ESTIMATED > UNKNOWN（见 compareCostSources）。
// 改价不追溯：折算发生在调用当时，用当时的合同价，快照留在 compute_attempts 里。

/** 上游成本来源，按优先级从高到低。 */
export const COST_SOURCES = Object.freeze(['REPORTED', 'COMPUTED', 'ESTIMATED', 'UNKNOWN']);

const COST_SOURCE_PRIORITY = Object.freeze({ REPORTED: 3, COMPUTED: 2, ESTIMATED: 1, UNKNOWN: 0 });

export function costSourcePriority(source) {
  const key = String(source || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(COST_SOURCE_PRIORITY, key) ? COST_SOURCE_PRIORITY[key] : -1;
}

/** 多个可用来源里挑优先级最高的那个（都不可用就给 UNKNOWN）。 */
export function preferredCostSource(...sources) {
  let best = 'UNKNOWN';
  for (const source of sources.flat()) {
    const key = String(source || '').trim().toUpperCase();
    if (costSourcePriority(key) > costSourcePriority(best)) best = key;
  }
  return best;
}

/**
 * 上游回传的币种写法并不统一 —— 文档示例写 `CNY`，**实测同一个接口回的是 `¥`**
 * （api.seedance.nz 图片任务终态：`data.usage = {amount: 0.040112, currency: "¥"}`），
 * 网关（new-api 风格）则写 `CNY`。这些都是人民币：该站点价格表、钱包余额都以元计。
 * 明确**不认** USD / $ / JPY 等：跨币种不并账，硬当人民币会把真实毛利算错。
 */
const CNY_CURRENCY_ALIASES = Object.freeze(['CNY', 'RMB', '¥', 'CN¥', '人民币']);

export function isCnyCurrency(value) {
  return CNY_CURRENCY_ALIASES.includes(String(value ?? '').trim().toUpperCase());
}

/** REPORTED 是否严格优先于 COMPUTED（守卫直接断言这条规则用）。 */
export function compareCostSources(left, right) {
  return costSourcePriority(left) - costSourcePriority(right);
}

const MODALITY_KEYS = Object.freeze(['TEXT', 'IMAGE', 'VIDEO', 'MUSIC']);
const UNIT_PRICE_FEN_KEYS = Object.freeze({
  TEXT: ['inputFenPer1kTokens', 'outputFenPer1kTokens'],
  IMAGE: ['perImageFen'],
  VIDEO: ['perSecondFen', 'audioExtraPerSecondFen'],
  MUSIC: ['perCallFen', 'perSecondFen'],
});

/** 非负整数分；非法 → null（**不是 0**）。 */
function fenAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** 非负整数计数（token 数 / 张数）；非法 → null。 */
function wholeCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** 正数（秒数）；非法或非正 → null。 */
function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function resolutionTier(map, resolution) {
  const key = String(resolution || '').trim();
  if (!key || !map || typeof map !== 'object') return null;
  return fenAmount(map[key]);
}

function normalizeResolutionMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, amount] of Object.entries(value)) {
    const tier = String(key || '').trim().slice(0, 40);
    const fen = fenAmount(amount);
    if (tier && fen !== null) out[tier] = fen;
  }
  return Object.keys(out).length ? out : null;
}

/** 一层「素材类型 → 单价」的归一化（渠道级与模型级覆盖共用同一套字段）。 */
function normalizeModalityPriceMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const modality of MODALITY_KEYS) {
    const value = raw[modality];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const price = {};
    for (const key of UNIT_PRICE_FEN_KEYS[modality]) {
      const fen = fenAmount(value[key]);
      if (fen !== null) price[key] = fen;
    }
    const byResolution = normalizeResolutionMap(value.byResolution);
    if (byResolution) price.byResolution = byResolution;
    if (Object.keys(price).length) out[modality] = price;
  }
  return Object.keys(out).length ? out : null;
}

/** 一层「素材类型 → 单价」的严格校验；problems 就地追加。level 用于报错里指明是渠道级还是模型级。 */
function validateModalityPrice(level, modality, raw, problems) {
  const key = String(modality || '').toUpperCase();
  if (!MODALITY_KEYS.includes(key)) { problems.push(`${level}：不支持的类型 ${modality}`); return; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`${level} · ${modality} 必须是对象`); return; }
  const allowed = [...UNIT_PRICE_FEN_KEYS[key], 'byResolution'];
  for (const [field, amount] of Object.entries(raw)) {
    if (!allowed.includes(field)) { problems.push(`${level} · ${modality}.${field} 不是已知的单价字段`); continue; }
    if (field === 'byResolution') {
      if (!amount || typeof amount !== 'object' || Array.isArray(amount)) { problems.push(`${level} · ${modality}.byResolution 必须是档位对象`); continue; }
      for (const [tier, tierAmount] of Object.entries(amount)) {
        if (!String(tier || '').trim()) problems.push(`${level} · ${modality}.byResolution 的档位名不能为空`);
        else if (fenAmount(tierAmount) === null) problems.push(`${level} · ${modality}.byResolution.${tier} 必须是非负整数分`);
      }
      continue;
    }
    if (fenAmount(amount) === null) problems.push(`${level} · ${modality}.${field} 必须是非负整数分`);
  }
}

/**
 * 渠道上的合同单价（upstreamUnitPrices）归一化。非法值一律**丢弃**而不是当成 0；
 * 全空时返回 null（= 没配单价）。
 * 形状：{ TEXT:{inputFenPer1kTokens,outputFenPer1kTokens},
 *        IMAGE:{perImageFen,byResolution:{'1K':30}}, VIDEO:{perSecondFen,byResolution,audioExtraPerSecondFen},
 *        MUSIC:{perCallFen,perSecondFen} }
 */
export function normalizeUpstreamUnitPrices(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  return input ? normalizeModalityPriceMap(input) : null;
}

/**
 * 模型级覆盖（modelUnitPrices）归一化：`{ [modelId]: { TEXT:{...}, IMAGE:{...} } }`，
 * 内层复用同一套单价字段。同一个渠道里 qwen-turbo 与 qwen-max 差十倍，靠这层区分。
 * 优先级：model > modality > null（见 resolveUnitPrice）。
 */
export function normalizeModelUnitPrices(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!input) return null;
  const out = {};
  for (const [modelId, raw] of Object.entries(input)) {
    const id = String(modelId || '').trim().slice(0, 200);
    if (!id) continue;
    const prices = normalizeModalityPriceMap(raw);
    if (prices) out[id] = prices;
  }
  return Object.keys(out).length ? out : null;
}

/** 保存前的严格校验（渠道级）：返回问题列表（空数组 = 合法）。 */
export function validateUpstreamUnitPrices(value) {
  if (value === null || value === undefined || value === '') return [];
  if (typeof value !== 'object' || Array.isArray(value)) return ['合同单价必须是按素材类型的对象'];
  const problems = [];
  for (const [modality, raw] of Object.entries(value)) {
    validateModalityPrice('合同单价', modality, raw, problems);
  }
  return problems;
}

/** 保存前的严格校验（模型级覆盖）：返回问题列表（空数组 = 合法）。 */
export function validateModelUnitPrices(value) {
  if (value === null || value === undefined || value === '') return [];
  if (typeof value !== 'object' || Array.isArray(value)) return ['模型级合同单价必须是「模型 → 单价」对象'];
  const problems = [];
  for (const [modelId, raw] of Object.entries(value)) {
    const id = String(modelId || '').trim();
    if (!id) { problems.push('模型级合同单价的模型编号不能为空'); continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`模型 ${id} 的合同单价必须是按素材类型的对象`); continue; }
    for (const [modality, price] of Object.entries(raw)) {
      validateModalityPrice(`模型 ${id}`, modality, price, problems);
    }
  }
  return problems;
}

/**
 * 选价：模型级覆盖 > 素材类型级 > 没有（null）。
 * 返回 { price, modelPrice, modalityPrice } | null：
 *   price = 两层逐字段合并后的视图（模型级优先，仅供调试/展示）；
 *   modelPrice / modalityPrice = 两层各自的原始价目，折算时按层取值（见 computeContractCost）。
 * 逐字段回退：模型级没写的字段（如 outputFenPer1kTokens）用素材类型级同名价。
 */
export function resolveUnitPrice({ unitPrices = null, modelUnitPrices = null, model = '', modality = '' } = {}) {
  const key = String(modality || '').trim().toUpperCase();
  const modelId = String(model || '').trim();
  const modalityPrice = normalizeUpstreamUnitPrices(unitPrices)?.[key] || null;
  const modelPrice = (modelId && normalizeModelUnitPrices(modelUnitPrices)?.[modelId]?.[key]) || null;
  if (modelPrice) return { price: { ...modalityPrice, ...modelPrice }, modelPrice, modalityPrice };
  if (modalityPrice) return { price: modalityPrice, modelPrice: null, modalityPrice };
  return null;
}

/**
 * 采集这次调用的**上游用量证据**。上游给了 token 用量就按上游的记；
 * 图片/视频/音乐这类没有 token 回执的，按请求参数记（秒数 / 张数 / 分辨率 / 含音频）。
 * 一律只记证据，不做任何折算。
 */
export function collectUsageEvidence({ modality, result = null, request = null } = {}) {
  const key = String(modality || '').trim().toUpperCase();
  const fromUsage = result?.usage && (result.usage.inputTokens != null || result.usage.outputTokens != null) ? result.usage : null;
  const tokens = fromUsage || (Array.isArray(result?.assets) ? result.assets.find((asset) => asset?.metadata?.tokens)?.metadata?.tokens : null) || null;
  const evidence = {
    modality: key,
    evidence: 'NONE',
    inputTokens: null,
    outputTokens: null,
    images: null,
    seconds: null,
    resolution: null,
    audio: null,
  };
  if (key === 'TEXT') {
    const input = wholeCount(tokens?.inputTokens);
    const output = wholeCount(tokens?.outputTokens);
    if (input !== null && output !== null) {
      evidence.evidence = 'UPSTREAM_USAGE';
      evidence.inputTokens = input;
      evidence.outputTokens = output;
    }
    return evidence;
  }
  if (key === 'IMAGE') {
    const images = wholeCount(request?.count) ?? 1;
    evidence.images = images > 0 ? images : 1;
    evidence.resolution = String(request?.resolution || '').trim() || null;
    evidence.evidence = 'REQUEST_PARAMS';
    return evidence;
  }
  if (key === 'VIDEO') {
    evidence.seconds = positiveNumber(request?.durationSeconds);
    evidence.resolution = String(request?.resolution || '').trim() || null;
    evidence.audio = typeof request?.audio === 'boolean' ? request.audio : null;
    evidence.evidence = evidence.seconds !== null ? 'REQUEST_PARAMS' : 'NONE';
    return evidence;
  }
  if (key === 'MUSIC') {
    evidence.seconds = positiveNumber(request?.durationSeconds);
    evidence.evidence = 'REQUEST_PARAMS';
    return evidence;
  }
  return evidence;
}

function result(fen, unitPrice, usage, level, layers) {
  return { fen, basis: 'CONTRACT_UNIT_PRICE', unitPrice, usage, level, layers };
}

/**
 * 按合同单价把用量证据折算成分（整数）。折算不出来 → null（UNKNOWN），绝不返回 0。
 * 选价优先级：模型级覆盖 > 素材类型级 > 没有（null）；模型级缺的字段回退素材类型级同名价。
 * 返回：{ fen, basis:'CONTRACT_UNIT_PRICE', unitPrice, usage, level, layers } | null
 * level  = 实际命中层级：'MODEL'（用到了模型级价）/ 'MODALITY'
 * layers = 实际用到的层级列表，例如 ['MODEL'] 或 ['MODEL','MODALITY']（混合）
 */
export function computeContractCost({ modality, model = '', unitPrices = null, modelUnitPrices = null, usage = null } = {}) {
  const selected = resolveUnitPrice({ unitPrices, modelUnitPrices, model, modality });
  if (!selected) return null;
  const key = String(modality || '').trim().toUpperCase();
  const { modelPrice, modalityPrice } = selected;
  const evidence = usage && typeof usage === 'object' ? usage : {};
  // 记录这次折算真正用到了哪几层的价，如实写进快照（混合时两层都在）。
  const levels = new Set();
  // 逐字段取值：模型级写了这个字段就用模型级，没写才回退素材类型级同名价。
  const field = (name) => {
    for (const [level, price] of [['MODEL', modelPrice], ['MODALITY', modalityPrice]]) {
      if (!price || !Object.prototype.hasOwnProperty.call(price, name)) continue;
      const fen = fenAmount(price[name]);
      if (fen !== null) return { fen, level };
    }
    return null;
  };
  // 档位价 vs 基准价：先看模型级（档位 → 基准价），模型级这一档给不出才回退素材类型级。
  const rate = (tierKey, baseKey) => {
    for (const [level, price] of [['MODEL', modelPrice], ['MODALITY', modalityPrice]]) {
      if (!price) continue;
      const tier = resolutionTier(price[tierKey], evidence.resolution);
      if (tier !== null) return { fen: tier, level, matchedResolution: String(evidence.resolution).trim() };
      const base = fenAmount(price[baseKey]);
      if (base !== null) return { fen: base, level };
    }
    return null;
  };
  const done = (fen, unitPrice, usedUsage) => {
    const layers = ['MODEL', 'MODALITY'].filter((level) => levels.has(level));
    return result(fen, unitPrice, usedUsage, layers.includes('MODEL') ? 'MODEL' : 'MODALITY', layers.length ? layers : ['MODALITY']);
  };

  if (key === 'TEXT') {
    const perInput = field('inputFenPer1kTokens');
    const perOutput = field('outputFenPer1kTokens');
    if (!perInput || !perOutput) return null; // 缺单价
    const input = wholeCount(evidence.inputTokens);
    const output = wholeCount(evidence.outputTokens);
    if (input === null || output === null) return null; // 缺用量
    levels.add(perInput.level); levels.add(perOutput.level);
    const inputFen = Math.round((input * perInput.fen) / 1000);
    const outputFen = Math.round((output * perOutput.fen) / 1000);
    return done(inputFen + outputFen, { inputFenPer1kTokens: perInput.fen, outputFenPer1kTokens: perOutput.fen }, { inputTokens: input, outputTokens: output, inputFen, outputFen });
  }

  if (key === 'IMAGE') {
    const images = wholeCount(evidence.images) ?? 1;
    if (images <= 0) return null;
    const picked = rate('byResolution', 'perImageFen');
    if (!picked) return null; // 缺单价（含「档位没配这一档」）
    levels.add(picked.level);
    return done(Math.round(images * picked.fen), { perImageFen: picked.fen, ...(picked.matchedResolution ? { matchedResolution: picked.matchedResolution } : {}) }, { images, resolution: String(evidence.resolution || '').trim() || null });
  }

  if (key === 'VIDEO') {
    const seconds = positiveNumber(evidence.seconds);
    if (seconds === null) return null; // 缺用量（拿不到请求秒数）
    const picked = rate('byResolution', 'perSecondFen');
    if (!picked) return null; // 缺单价
    levels.add(picked.level);
    let fen = Math.round(seconds * picked.fen);
    const audio = evidence.audio === true;
    const audioField = audio ? field('audioExtraPerSecondFen') : null;
    if (audio && !audioField) return null; // 含音频但没配含音频价
    if (audioField) { levels.add(audioField.level); fen += Math.round(seconds * audioField.fen); }
    return done(fen, { perSecondFen: picked.fen, ...(picked.matchedResolution ? { matchedResolution: picked.matchedResolution } : {}), ...(audioField ? { audioExtraPerSecondFen: audioField.fen } : {}) }, { seconds, resolution: String(evidence.resolution || '').trim() || null, audio });
  }

  if (key === 'MUSIC') {
    const seconds = positiveNumber(evidence.seconds);
    // 先看模型级（有时长且配了每秒价就按时长，否则按次），模型级给不出才看素材类型级。
    for (const [level, price] of [['MODEL', modelPrice], ['MODALITY', modalityPrice]]) {
      if (!price) continue;
      if (seconds !== null) {
        const perSecond = fenAmount(price.perSecondFen);
        if (perSecond !== null) { levels.add(level); return done(Math.round(seconds * perSecond), { perSecondFen: perSecond }, { seconds }); }
      }
      const perCall = fenAmount(price.perCallFen);
      if (perCall !== null) { levels.add(level); return done(perCall, { perCallFen: perCall }, { seconds }); }
    }
    return null; // 缺单价（按时长算但没配每秒价，且没有按次价）
  }

  return null;
}

/**
 * cost_rule_snapshot：记录了**所用价**、**用量快照**与**命中的层级**（改价不追溯靠它留证）。
 * 折算不出来时返回 null —— 调用方保持原快照不变（例如 CONFIGURED_ESTIMATE 那条）。
 */
export function contractCostRuleSnapshot({ provider, channelId, model, estimatedCostFen = null, computed = null, capturedAt = null } = {}) {
  if (!computed) return null;
  const layers = Array.isArray(computed.layers) && computed.layers.length ? [...computed.layers] : [computed.level === 'MODEL' ? 'MODEL' : 'MODALITY'];
  return {
    basis: 'CONTRACT_UNIT_PRICE',
    provider: provider ?? null,
    channelId: channelId ?? null,
    model: model ?? null,
    estimatedCostFen: estimatedCostFen === null || estimatedCostFen === undefined ? null : Number(estimatedCostFen),
    source: 'COMPUTED',
    // 命中的层级：MODEL=用到模型级覆盖价，MODALITY=只用素材类型价（layers 给出完整列表，混合时为两层）
    priceLevel: layers.includes('MODEL') ? 'MODEL' : 'MODALITY',
    priceLayers: layers,
    unitPrice: computed.unitPrice,
    usage: computed.usage,
    computedFen: computed.fen,
    capturedAt: capturedAt || new Date().toISOString(),
  };
}

/**
 * 上游直接报实扣（REPORTED）时的成本规则快照：没有"规则"可讲，但要留下**证据** ——
 * 上游原样回传的币种写法（实测是「¥」而不是文档写的 CNY）和**未取整**的金额。
 * 分是四舍五入来的（实测 ¥0.040112 → 4 分），把原始值留住才解释得清每一分怎么来的。
 */
export function reportedCostRuleSnapshot({ provider = null, channelId = null, model = null, reported = null, capturedAt = null } = {}) {
  if (!reported) return null;
  return {
    basis: 'UPSTREAM_REPORTED',
    provider: provider ?? null,
    channelId: channelId ?? null,
    model: model ?? null,
    source: 'REPORTED',
    upstreamCurrency: reported.upstreamCurrency ?? reported.currency ?? null,
    upstreamAmount: Number(reported.amount),
    reportedFen: Math.round(Number(reported.amount) * 100),
    capturedAt: capturedAt || new Date().toISOString(),
  };
}
