// 模型能力目录：每个渠道的每个模型可以单独声明
//   比例（aspectRatios）/ 清晰度（resolutions）/ 时长（durations，仅视频）/ 是否支持生成音频（audio，仅视频）
// 未声明的模型回落到模态默认值。这些值是「发给模型的原始取值」，所以按原样存、按原样发。
const MAX_LIST = 24;

// 视频模型是否需要输入画面（首帧）：i2v（图生视频）类模型必须带首帧图，
// 上游会直接拒绝纯文本请求。默认按模型 id 里的 i2v 后缀推断，管理员可在渠道里覆盖。
export const INPUT_FRAME_VALUES = Object.freeze(['NONE', 'FIRST']);

export function defaultInputFrame(modelId) {
  return /(^|[-_/])i2v($|[-_/])/i.test(String(modelId || '').trim()) ? 'FIRST' : 'NONE';
}

export const MODALITY_CAPABILITY_DEFAULTS = Object.freeze({
  // 默认值刻意保持与改造前硬编码一致（图片 1k、视频 480p / 5 秒），避免升级即改变线上请求。
  IMAGE: Object.freeze({ aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'], resolutions: ['1k', '2k', '4k'], durations: [], audio: false }),
  VIDEO: Object.freeze({ aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['480p', '720p', '1080p', '2k', '4k'], durations: [5, 10], audio: false, inputFrame: 'NONE' }),
});

// 比例归一化：接受 9:16 / 9：16 / 9/16 / 9x16 等写法。
export function normalizeAspectRatio(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/\s+/g, '').replace(/[：]/g, ':').replace(/[×xX*／/]/g, ':');
  const match = cleaned.match(/^(\d{1,4}):(\d{1,4})$/);
  if (!match || !Number(match[1]) || !Number(match[2])) return '';
  return `${Number(match[1])}:${Number(match[2])}`;
}

function stringList(value, { max = MAX_LIST, maxLength = 24, normalize } = {}) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    let text = String(item ?? '').trim().slice(0, maxLength);
    if (normalize) text = normalize(text);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function durationList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const n = Number(item);
    if (!Number.isInteger(n) || n < 1 || n > 600 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= MAX_LIST) break;
  }
  return out.sort((a, b) => a - b);
}

/** 归一化单个模型的能力声明；模态不支持的能力项会被清空。 */
export function normalizeModelCapabilities(value, modality, modelId = '') {
  const key = String(modality || '').toUpperCase();
  const input = value && typeof value === 'object' ? value : {};
  const result = {
    aspectRatios: stringList(input.aspectRatios, { normalize: (text) => normalizeAspectRatio(text) }),
    resolutions: stringList(input.resolutions),
    durations: key === 'VIDEO' ? durationList(input.durations) : [],
    audio: key === 'VIDEO' ? input.audio === true || input.audio === 1 || String(input.audio).toLowerCase() === 'true' : false,
    inputFrame: key === 'VIDEO' ? normalizeInputFrame(input.inputFrame, modelId) : 'NONE',
  };
  return result;
}

function normalizeInputFrame(value, modelId) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (INPUT_FRAME_VALUES.includes(raw)) return raw;
  return defaultInputFrame(modelId);
}

/** 渠道级 modelCapabilities 归一化：{ [modelId]: {...} } */
export function normalizeChannelModelCapabilities(value, modality) {
  const input = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const [modelId, capabilities] of Object.entries(input).slice(0, 200)) {
    const id = String(modelId || '').trim().slice(0, 200);
    if (!id) continue;
    out[id] = normalizeModelCapabilities(capabilities, modality, id);
  }
  return out;
}

export function defaultCapabilities(modality, modelId = '') {
  const key = String(modality || '').toUpperCase();
  const base = MODALITY_CAPABILITY_DEFAULTS[key] || { aspectRatios: [], resolutions: [], durations: [], audio: false, inputFrame: 'NONE' };
  return key === 'VIDEO' ? { ...base, inputFrame: defaultInputFrame(modelId) } : { ...base };
}

/** 取某模型的有效能力：模型级配置优先，其次模态默认值（含 i2v 推断）。 */
export function effectiveCapabilities(channel, modality, modelId) {
  const key = String(modality || '').toUpperCase();
  const id = String(modelId || '').trim();
  const configured = channel?.modelCapabilities?.[id];
  if (configured && typeof configured === 'object') return normalizeModelCapabilities(configured, key, id);
  return defaultCapabilities(key, id);
}

/**
 * 列出某模态渠道下可用的模型及其能力。
 * 返回 [{ id, isDefault, capabilities }]，供课时配置的下拉项使用。
 */
export function listChannelModels(policy, modality) {
  const key = String(modality || '').toUpperCase();
  const channelId = policy?.modalityChannels?.[key];
  const channel = Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === channelId) : null;
  if (!channel) return [];
  const ids = Array.isArray(channel.models) && channel.models.length ? channel.models : (channel.model ? [channel.model] : []);
  const seen = new Set();
  const out = [];
  for (const raw of ids) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, isDefault: id === channel.model, capabilities: effectiveCapabilities(channel, key, id) });
  }
  return out;
}

/** 生成请求模板的可用占位符。 */
export const TEMPLATE_PLACEHOLDERS = Object.freeze(['model', 'prompt', 'title', 'aspectRatio', 'resolution', 'durationSeconds', 'audio', 'voice', 'n', 'firstFrameUrl']);

// 默认请求模板刻意与改造前的请求体同形，只把写死的值换成占位符：
// 管理员没改模板时，线上请求形状不变。视频的比例与音频放在 metadata 里（该字段原本就是透传袋），
// 若某家模型要求在顶层，管理员在「计费与模型」里把占位符挪到顶层即可。
export const DEFAULT_REQUEST_TEMPLATES = Object.freeze({
  IMAGE: Object.freeze({ model: '{{model}}', prompt: '{{prompt}}', n: 1, size: '{{aspectRatio}}', metadata: { resolution: '{{resolution}}', output_format: 'png' } }),
  VIDEO: Object.freeze({ model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationSeconds}}', metadata: { resolution: '{{resolution}}', aspect_ratio: '{{aspectRatio}}', audio: '{{audio}}' } }),
  // 图生视频：上游要的是顶层 image 字段。注意 api.seedance.nz 的报错文案写的是
  // "firstFrameUrl is required"，但实测真正被接受的键是 image（传 firstFrameUrl 反而 400）。
  VIDEO_I2V: Object.freeze({ model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationSeconds}}', image: '{{firstFrameUrl}}', metadata: { resolution: '{{resolution}}', aspect_ratio: '{{aspectRatio}}', audio: '{{audio}}' } }),
  TEXT: Object.freeze({ model: '{{model}}', messages: [{ role: 'system', content: '你是少儿编程学习平台的创作助手。请用适合儿童理解的方式回答，避免危险或不适龄内容。' }, { role: 'user', content: '{{prompt}}' }] }),
  DUBBING: Object.freeze({ model: '{{model}}', input: '{{prompt}}', voice: '{{voice}}', response_format: 'mp3' }),
});

function templateValue(key, context) {
  const value = context[key];
  // 视频时长沿用改造前的字符串形态（seconds: '5'），避免改动线上请求类型。
  if (key === 'durationSeconds') return String(Number(value) || 0);
  if (key === 'n') return Number(value) || 0;
  if (key === 'audio') return value === true;
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 用模板生成请求体：先解析模板 JSON，再递归替换占位符。
 * 整个字符串就是 {{key}} 时替换为对应类型（数字/布尔），否则做字符串拼接，避免引号把 JSON 弄坏。
 */
export function renderRequestTemplate(template, context) {
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    if (typeof node !== 'string') return node;
    const exact = node.match(/^\{\{(\w+)\}\}$/);
    if (exact && TEMPLATE_PLACEHOLDERS.includes(exact[1])) return templateValue(exact[1], context);
    return node.replace(/\{\{(\w+)\}\}/g, (match, key) => (TEMPLATE_PLACEHOLDERS.includes(key) ? String(templateValue(key, context)) : match));
  };
  return walk(template);
}

/** 校验管理员填写的模板：必须是 JSON 对象。返回 { valid, template, error }。 */
export function parseRequestTemplate(text) {
  if (text === undefined || text === null || text === '') return { valid: true, template: null, error: '' };
  if (typeof text === 'object') return { valid: true, template: text, error: '' };
  try {
    const parsed = JSON.parse(String(text));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false, template: null, error: '请求模板必须是一个 JSON 对象' };
    return { valid: true, template: parsed, error: '' };
  } catch (error) {
    return { valid: false, template: null, error: '请求模板不是合法 JSON：' + (error?.message || '解析失败') };
  }
}

export function requestTemplateFor(channel, modality, { requiresFirstFrame = false } = {}) {
  const key = String(modality || '').toUpperCase();
  const custom = channel?.requestTemplates?.[key];
  if (custom && typeof custom === 'object') return custom;
  if (key === 'VIDEO' && requiresFirstFrame) return DEFAULT_REQUEST_TEMPLATES.VIDEO_I2V;
  return DEFAULT_REQUEST_TEMPLATES[key] || null;
}

/** 取某模态当前生效的渠道（能力路由里配置的那个）。 */
export function modalityChannel(policy, modality) {
  const key = String(modality || '').toUpperCase();
  const channelId = policy?.modalityChannels?.[key];
  return Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === channelId) || null : null;
}
