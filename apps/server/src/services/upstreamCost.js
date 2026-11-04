// P90 合同单价 → 逐笔自动上游计费
//
// 口径（与产品约定一致，别在别处再抄一遍）：
//   · 文本：上游 input/output tokens × 每百万 token 合同价（分/百万 token，整数）；
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
// ⚠️ TEXT 的单位是**分 / 百万 token**（2026-09-15 改）。
// 原来按「分 / 千 token」，对 DeepSeek 这类便宜模型根本填不进去：官方价是「元 / 百万 token」，
// deepseek-flash 输入 2 元 / 输出 8 元 → 换算成「分 / 千」是 0.2 分 / 0.8 分，**不是整数分**，
// 只能填 0 或 1，误差 5 倍以上。改成「分 / 百万 token」后这些价正好是整数（200 / 800）。
const UNIT_PRICE_FEN_KEYS = Object.freeze({
  TEXT: ['inputFenPer1MTokens', 'outputFenPer1MTokens', 'cacheHitFenPer1MTokens'],
  IMAGE: ['perImageFen'],
  VIDEO: ['perSecondFen', 'audioExtraPerSecondFen'],
  MUSIC: ['perCallFen', 'perSecondFen'],
});

// 文本分时价（2026-11-04 用户口径）：备用渠道分高峰/闲时，按北京时间判断。
//   · 高峰 = 周一至周五的 peakWindows（默认 9:00-12:00、14:00-18:00），且不在 holidays 里；
//   · 其余（含周末、法定节假日全天）= 闲时；
//   · 中国没有夏令时，直接按 UTC+8 算，不依赖服务器时区。
// holidays 是 YYYY-MM-DD 列表，法定节假日要每年维护（平台不内置日历）。
const TEXT_TIME_KEYS = Object.freeze(['inputFenPer1MTokens', 'outputFenPer1MTokens', 'cacheHitFenPer1MTokens']);
const DEFAULT_PEAK_WINDOWS = Object.freeze([
  Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: '09:00', end: '12:00' }),
  Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), start: '14:00', end: '18:00' }),
]);

/** 非负金额；TEXT 的缓存价可能是 0.025 元 = 2.5 分，所以 TEXT 允许小数（保留 4 位）。 */
function priceAmount(value, allowFraction = false) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return allowFraction ? subFen(n) : Math.round(n);
}

/** 非负整数分；非法 → null（**不是 0**）。 */
function fenAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * 分以下的小数（保留 4 位，即 0.0001 分）。
 * 只有**单笔成本天然小于 1 分**的场景才用得上（目前只有文本：DeepSeek 一次课堂对话约 0.2 分）——
 * 见 computeContractCost 里 TEXT 分支的说明。整数输入原样返回，不影响其它模态。
 */
function subFen(value) {
  return Math.round(Number(value) * 10000) / 10000;
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

function normalizeClock(value) {
  const text = String(value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(text)) return null;
  const [hour, minute] = text.split(':').map(Number);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeTextWindow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of TEXT_TIME_KEYS) {
    const fen = priceAmount(raw[key], true);
    if (fen !== null) out[key] = fen;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeTimePricing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const peak = normalizeTextWindow(raw.peak);
  const offPeak = normalizeTextWindow(raw.offPeak);
  if (!peak && !offPeak) return null;
  const windows = (Array.isArray(raw.peakWindows) ? raw.peakWindows : DEFAULT_PEAK_WINDOWS).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const days = [...new Set((Array.isArray(item.days) ? item.days : []).map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
    const start = normalizeClock(item.start);
    const end = normalizeClock(item.end);
    if (!days.length || !start || !end || start >= end) return [];
    return [{ days, start, end }];
  }).slice(0, 14);
  const holidays = [...new Set((Array.isArray(raw.holidays) ? raw.holidays : [])
    .map((item) => String(item || '').trim())
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item)))].slice(0, 400);
  return {
    timezone: String(raw.timezone || 'Asia/Shanghai').slice(0, 64),
    peak,
    offPeak,
    peakWindows: windows.length ? windows : DEFAULT_PEAK_WINDOWS.map((item) => ({ ...item, days: [...item.days] })),
    holidays,
  };
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
      const fen = priceAmount(value[key], modality === 'TEXT');
      if (fen !== null) price[key] = fen;
    }
    if (modality === 'TEXT') {
      const timePricing = normalizeTimePricing(value.timePricing);
      if (timePricing) price.timePricing = timePricing;
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
  const allowed = [...UNIT_PRICE_FEN_KEYS[key], 'byResolution', ...(key === 'TEXT' ? ['timePricing'] : [])];
  const amountOk = (value) => (key === 'TEXT' ? priceAmount(value, true) : fenAmount(value)) !== null;
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
    if (field === 'timePricing') {
      if (!amount || typeof amount !== 'object' || Array.isArray(amount)) { problems.push(`${level} · ${modality}.timePricing 必须是对象`); continue; }
      for (const window of ['peak', 'offPeak']) {
        const entry = amount[window];
        if (entry === undefined || entry === null) continue;
        if (typeof entry !== 'object' || Array.isArray(entry)) { problems.push(`${level} · ${modality}.timePricing.${window} 必须是对象`); continue; }
        for (const [fieldName, fieldAmount] of Object.entries(entry)) {
          if (!TEXT_TIME_KEYS.includes(fieldName)) problems.push(`${level} · ${modality}.timePricing.${window}.${fieldName} 不是已知的单价字段`);
          else if (priceAmount(fieldAmount, true) === null) problems.push(`${level} · ${modality}.timePricing.${window}.${fieldName} 必须是非负金额`);
        }
      }
      continue;
    }
    if (!amountOk(amount)) problems.push(`${level} · ${modality}.${field} 必须是${key === 'TEXT' ? '非负金额' : '非负整数分'}`);
  }
}

/**
 * 渠道上的合同单价（upstreamUnitPrices）归一化。非法值一律**丢弃**而不是当成 0；
 * 全空时返回 null（= 没配单价）。
 * 形状：{ TEXT:{inputFenPer1MTokens,outputFenPer1MTokens},
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
 * 逐字段回退：模型级没写的字段（如 outputFenPer1MTokens）用素材类型级同名价。
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
      // 缓存拆分：DeepSeek 系回 prompt_cache_hit_tokens / miss；上游没回就是 null（按全价输入算）。
      const cacheHit = wholeCount(tokens?.cacheHitTokens);
      const cacheMiss = wholeCount(tokens?.cacheMissTokens);
      if (cacheHit !== null) evidence.cacheHitTokens = cacheHit;
      if (cacheMiss !== null) evidence.cacheMissTokens = cacheMiss;
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
 * 北京时间是否高峰：周一至周五的 peakWindows 内，且当天不在 holidays 里。
 * 中国没有夏令时，直接按 UTC+8 算，不依赖服务器时区。
 */
function isPeakTextTime(timePricing, atMs) {
  if (!timePricing) return false;
  const bj = new Date(Number(atMs) + 8 * 3600_000);
  const day = bj.getUTCDay();
  const today = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`;
  if ((timePricing.holidays || []).includes(today)) return false;
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  for (const window of timePricing.peakWindows || []) {
    if (!window.days.includes(day)) continue;
    const [startHour, startMinute] = window.start.split(':').map(Number);
    const [endHour, endMinute] = window.end.split(':').map(Number);
    if (minutes >= startHour * 60 + startMinute && minutes < endHour * 60 + endMinute) return true;
  }
  return false;
}

/**
 * 按合同单价把用量证据折算成分（整数）。折算不出来 → null（UNKNOWN），绝不返回 0。
 * 选价优先级：模型级覆盖 > 素材类型级 > 没有（null）；模型级缺的字段回退素材类型级同名价。
 * 返回：{ fen, basis:'CONTRACT_UNIT_PRICE', unitPrice, usage, level, layers } | null
 * level  = 实际命中层级：'MODEL'（用到了模型级价）/ 'MODALITY'
 * layers = 实际用到的层级列表，例如 ['MODEL'] 或 ['MODEL','MODALITY']（混合）
 */
export function computeContractCost({ modality, model = '', unitPrices = null, modelUnitPrices = null, usage = null, priceCurrency = 'CNY', usdCnyRate = null, at = null } = {}) {
  const selected = resolveUnitPrice({ unitPrices, modelUnitPrices, model, modality });
  if (!selected) return null;
  const key = String(modality || '').trim().toUpperCase();
  const { modelPrice, modalityPrice } = selected;
  const evidence = usage && typeof usage === 'object' ? usage : {};
  // 记录这次折算真正用到了哪几层的价，如实写进快照（混合时两层都在）。
  const levels = new Set();
  // 文本分时价：该层配了 timePricing 就按调用时间选高峰/闲时，并用它的字段覆盖同名字段。
  const atMs = at ? Date.parse(at) : Date.now();
  const timed = (price) => {
    if (!price?.timePricing) return price;
    const picked = isPeakTextTime(price.timePricing, Number.isFinite(atMs) ? atMs : Date.now())
      ? price.timePricing.peak
      : price.timePricing.offPeak;
    return picked ? { ...price, ...picked } : price;
  };
  // 逐字段取值：模型级写了这个字段就用模型级，没写才回退素材类型级同名价。
  const field = (name) => {
    for (const [level, price] of [['MODEL', timed(modelPrice)], ['MODALITY', timed(modalityPrice)]]) {
      if (!price || !Object.prototype.hasOwnProperty.call(price, name)) continue;
      const fen = priceAmount(price[name], key === 'TEXT');
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
    const currency = String(priceCurrency || 'CNY').toUpperCase();
    if (currency === 'USD') {
      // RunningHub 的价目是美元（字段里存的是**美分**）。按固定 6.71749 折人民币；
      // 拿不到汇率宁可回落 UNKNOWN，绝不按 0 记成本。
      const rate = Number(usdCnyRate);
      if (!Number.isFinite(rate) || rate <= 0) return null;
      const converted = key === 'TEXT' ? subFen(fen * rate) : Math.round(fen * rate);
      return result(converted, { ...unitPrice, priceCurrency: 'USD', usdCnyRate: rate }, usedUsage, layers.includes('MODEL') ? 'MODEL' : 'MODALITY', layers.length ? layers : ['MODALITY']);
    }
    return result(fen, unitPrice, usedUsage, layers.includes('MODEL') ? 'MODEL' : 'MODALITY', layers.length ? layers : ['MODALITY']);
  };

  if (key === 'TEXT') {
    const perInput = field('inputFenPer1MTokens');
    const perOutput = field('outputFenPer1MTokens');
    if (!perInput || !perOutput) return null; // 缺单价
    const input = wholeCount(evidence.inputTokens);
    const output = wholeCount(evidence.outputTokens);
    if (input === null || output === null) return null; // 缺用量
    levels.add(perInput.level); levels.add(perOutput.level);
    // 单位是分/百万 token。⚠️ 单笔成本**常常小于 1 分**（DeepSeek 一次课堂对话约 0.2 分），
    // 所以这里**不按整数分取整**，保留到 0.0001 分（compute_attempts.upstream_cost_fen 本来就是 REAL，
    // double 精度对任何现实累计额都够）。若按整数分取整，每一笔都会记成 0 ——
    // 一节课的文本成本整块消失，文本那一侧的「机构/学生消耗 vs 我们实际消耗」对照永远是空的。
    // （图片/视频/音乐的单笔都是整数分，各自的分支不需要这层小数。）
    // 缓存：配了 cacheHitFenPer1MTokens 且上游回了 cache 命中数，就按「命中价 × 命中 + 未命中价 × 未命中」拆。
    // 没配缓存价或没有回执 → 全部输入按 inputFenPer1MTokens 算（绝不把命中数当 0 价）。
    const perCache = field('cacheHitFenPer1MTokens');
    const hit = wholeCount(evidence.cacheHitTokens);
    const missed = wholeCount(evidence.cacheMissTokens);
    let inputFen;
    let cacheSplit = null;
    if (perCache && hit !== null && hit > 0) {
      levels.add(perCache.level);
      const missTokens = missed !== null ? missed : Math.max(0, input - hit);
      inputFen = subFen((hit * perCache.fen + missTokens * perInput.fen) / 1000000);
      cacheSplit = { cacheHitTokens: hit, cacheMissTokens: missTokens, cacheHitFenPer1MTokens: perCache.fen };
    } else {
      inputFen = subFen((input * perInput.fen) / 1000000);
    }
    const outputFen = subFen((output * perOutput.fen) / 1000000);
    return done(subFen(inputFen + outputFen), {
      inputFenPer1MTokens: perInput.fen,
      outputFenPer1MTokens: perOutput.fen,
      ...(perCache ? { cacheHitFenPer1MTokens: perCache.fen } : {}),
    }, { inputTokens: input, outputTokens: output, ...(cacheSplit || {}), inputFen, outputFen });
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
    // 2026-11-04 实测：RunningHub `usage.billingSeconds` 就是 5（没有 5→9 的最低计费），
    // 且 REPORTED 成本优先；这里只做价目兜底，按实际请求秒数算。
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
    upstreamAmount: Number(reported.upstreamAmount ?? reported.amount),
    reportedFen: Number.isFinite(Number(reported.fen)) ? Number(reported.fen) : Math.round(Number(reported.amount) * 100),
    ...(reported.usdCnyRate ? { usdCnyRate: Number(reported.usdCnyRate) } : {}),
    ...(reported.billingSeconds ? { billingSeconds: Number(reported.billingSeconds) } : {}),
    capturedAt: capturedAt || new Date().toISOString(),
  };
}
