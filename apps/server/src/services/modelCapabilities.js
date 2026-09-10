// 模型能力目录：每个渠道的每个模型可以单独声明
//   比例（aspectRatios）/ 清晰度（resolutions）/ 时长（durations，仅视频）/ 是否支持生成音频（audio，仅视频）
// 未声明的模型回落到模态默认值。这些值是「发给模型的原始取值」，所以按原样存、按原样发。
const MAX_LIST = 24;

// 视频模型的「输入画面」支持方式，可多选：一个模型可以同时支持多种
// （MiniMax-H3 就是文生/图生/首尾帧/多素材参考都支持），所以这里是能力集合，不是二选一。
//   TEXT               文生视频（可以只给文本）
//   FIRST_FRAME        图生视频（可以给一张首帧图）
//   FIRST_LAST_FRAME   首尾帧参考（首帧 + 尾帧）
//   OMNI_REFERENCE     全能参考（多张图片 / 多段视频 / 多段音频混合参考）
export const INPUT_MODES = Object.freeze(['TEXT', 'FIRST_FRAME', 'FIRST_LAST_FRAME', 'OMNI_REFERENCE']);

export const INPUT_MODE_LABELS = Object.freeze({
  TEXT: '文生视频（纯文本）',
  FIRST_FRAME: '图生视频（首帧图）',
  FIRST_LAST_FRAME: '首尾帧参考（首帧+尾帧）',
  OMNI_REFERENCE: '全能参考（多图/多视频/多音频）',
});

// 旧写法（含 2026-09-10 上线的三态版本）统一映射到新枚举。
const INPUT_MODE_ALIASES = Object.freeze({
  NONE: 'TEXT',
  FIRST: 'FIRST_FRAME',
  LAST: 'FIRST_LAST_FRAME',
  LAST_FRAME: 'FIRST_LAST_FRAME',
  OMNI: 'OMNI_REFERENCE',
  REFERENCE: 'OMNI_REFERENCE',
});

export function normalizeInputModeValue(value) {
  const text = String(value ?? '').trim().toUpperCase();
  return INPUT_MODE_ALIASES[text] || text;
}

export function defaultInputModes(modelId) {
  return /(^|[-_/])i2v($|[-_/])/i.test(String(modelId || '').trim()) ? ['FIRST_FRAME'] : ['TEXT'];
}

// 音乐的生成模式：歌词生音乐（学生直接写词）/ 描述生音乐（平台先用文本模型把描述写成歌词）
export const MUSIC_MODES = Object.freeze(['LYRICS', 'DESCRIPTION']);

export const MODALITY_CAPABILITY_DEFAULTS = Object.freeze({
  // 默认值刻意保持与改造前硬编码一致（图片 1k、视频 480p / 5 秒），避免升级即改变线上请求。
  IMAGE: Object.freeze({ aspectRatios: ['1:1', '4:3', '3:4', '16:9', '9:16'], resolutions: ['1k', '2k', '4k'], durations: [], audio: false }),
  VIDEO: Object.freeze({ aspectRatios: ['16:9', '9:16', '1:1'], resolutions: ['480p', '720p', '1080p', '2k', '4k'], durations: [5, 10], audio: false }),
  MUSIC: Object.freeze({ modes: ['LYRICS', 'DESCRIPTION'] }),
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
    inputModes: key === 'VIDEO' ? normalizeInputModes(input.inputModes ?? input.inputFrame, modelId) : [],
    modes: key === 'MUSIC' ? normalizeMusicModes(input.modes) : [],
  };
  return result;
}

// 接受新的多选数组，也接受旧版单值 inputFrame（NONE/FIRST/LAST），未声明时按模型名推断。
// 音乐的生成模式：留空＝两种都支持（与上游一致）。
function normalizeMusicModes(value) {
  if (!Array.isArray(value)) return [...MUSIC_MODES];
  const modes = [...new Set(value.map((item) => String(item ?? '').trim().toUpperCase()).filter((item) => MUSIC_MODES.includes(item)))];
  return modes.length ? modes : [...MUSIC_MODES];
}

function normalizeInputModes(value, modelId) {
  if (!Array.isArray(value) && (value === undefined || value === null || value === '')) return defaultInputModes(modelId);
  const raw = Array.isArray(value) ? value : [value];
  const mapped = raw.map((item) => normalizeInputModeValue(item)).filter((item) => INPUT_MODES.includes(item));
  const modes = [...new Set(mapped)];
  return modes.length ? modes : defaultInputModes(modelId);
}

/** 该模型是否只能靠画面输入（不支持纯文本）：不支持文生就必须给首帧。 */
export function requiresFirstFrameFor(inputModes) {
  const modes = Array.isArray(inputModes) ? inputModes : [];
  return modes.length > 0 && !modes.includes('TEXT');
}

/** 该模型是否接受首帧图（图生 / 首尾帧 / 全能参考都算）。 */
export function acceptsFirstFrame(inputModes) {
  const modes = Array.isArray(inputModes) ? inputModes : [];
  return modes.includes('FIRST_FRAME') || modes.includes('FIRST_LAST_FRAME') || modes.includes('OMNI_REFERENCE');
}

/** 该模型是否接受尾帧图（首尾帧 / 全能参考）。 */
export function acceptsLastFrame(inputModes) {
  const modes = Array.isArray(inputModes) ? inputModes : [];
  return modes.includes('FIRST_LAST_FRAME') || modes.includes('OMNI_REFERENCE');
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

/**
 * 保存渠道配置前校验「模型能力」的填写：非法写法当场报错，避免静默丢弃或把错值发给上游。
 * 只校验格式，不校验该模型是否真的支持（平台无法知道）。
 */
export function validateModelCapabilitiesInput(value, modality, modelId = '') {
  const key = String(modality || '').toUpperCase();
  const input = value && typeof value === 'object' ? value : {};
  const errors = [];
  const asList = (item) => (Array.isArray(item) ? item : item === undefined || item === null || item === '' ? [] : [item]);
  for (const item of asList(input.aspectRatios)) {
    if (!normalizeAspectRatio(item)) errors.push(`比例「${String(item ?? '').slice(0, 20)}」格式不对（示例：16:9、9:16）`);
  }
  for (const item of asList(input.resolutions)) {
    const text = String(item ?? '').trim();
    if (!text) { errors.push('清晰度不能为空'); continue; }
    if (text.length > 24 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) errors.push(`清晰度「${text.slice(0, 20)}」含有不支持的字符（只允许字母/数字/点/横线，示例：480p、768P、2K）`);
  }
  if (key === 'VIDEO') {
    for (const item of asList(input.durations)) {
      const n = Number(item);
      if (!Number.isInteger(n) || n < 1 || n > 600) errors.push(`时长「${String(item ?? '').slice(0, 20)}」必须是 1–600 的整数秒（示例：5、10、15）`);
    }
    const modesValue = input.inputModes ?? input.inputFrame;
    if (modesValue !== undefined && modesValue !== null && modesValue !== '') {
      const raw = Array.isArray(modesValue) ? modesValue : [modesValue];
      const mapped = raw.map((item) => normalizeInputModeValue(item));
      const invalid = mapped.filter((item) => !INPUT_MODES.includes(item));
      // 空数组＝未声明，跟留空一样按模型名自动判断，不算错。
      if (invalid.length) errors.push(`「输入画面」只支持 文生视频 / 图生视频（首帧）/ 首尾帧参考 / 全能参考，不认识：${invalid.join('、')}`);
    }
    const audio = input.audio;
    if (audio !== undefined && typeof audio !== 'boolean' && audio !== 1 && audio !== 0) errors.push('「支持生成音频」只能是勾选或不勾选');
  }
  if (key === 'MUSIC' && input.modes !== undefined && input.modes !== null) {
    const list = Array.isArray(input.modes) ? input.modes : [input.modes];
    const invalid = list.map((item) => String(item ?? '').trim().toUpperCase()).filter((item) => item && !MUSIC_MODES.includes(item));
    if (invalid.length) errors.push(`音乐的生成模式只支持 歌词生音乐 / 描述生音乐，不认识：${invalid.join('、')}`);
  }
  return errors;
}

/**
 * 音乐的请求上下文：歌词模式下学生的输入就是要唱的词；描述模式下学生的输入是曲风/描述，
 * 歌词由平台代写后传进来。模板与适配器共用这一个函数，避免两边算法不一致。
 */
export function musicRequestContext({ prompt = '', mode = '', lyrics = '' } = {}) {
  const normalizedMode = String(mode || '').trim().toUpperCase();
  const written = String(lyrics || '').trim();
  const input = String(prompt || '').trim();
  if (normalizedMode === 'DESCRIPTION') return { lyrics: written, style: input };
  return { lyrics: written || input, style: '' };
}

export function defaultCapabilities(modality, modelId = '') {
  const key = String(modality || '').toUpperCase();
  const base = MODALITY_CAPABILITY_DEFAULTS[key] || { aspectRatios: [], resolutions: [], durations: [], audio: false };
  return key === 'VIDEO' ? { ...base, inputModes: defaultInputModes(modelId) } : { ...base };
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
// durationSeconds 保持改造前的字符串形态（seconds: '5'），需要数字的上游用 durationSecondsNumber。
export const TEMPLATE_PLACEHOLDERS = Object.freeze(['model', 'prompt', 'title', 'aspectRatio', 'resolution', 'durationSeconds', 'durationSecondsNumber', 'audio', 'voice', 'n', 'firstFrameUrl', 'lastFrameUrl', 'frameItems', 'referenceItems', 'lyrics', 'style', 'messages']);

// 默认请求模板刻意与改造前的请求体同形，只把写死的值换成占位符：
// 管理员没改模板时，线上请求形状不变。视频的比例与音频放在 metadata 里（该字段原本就是透传袋），
// 若某家模型要求在顶层，管理员在「计费与模型」里把占位符挪到顶层即可。
export const DEFAULT_REQUEST_TEMPLATES = Object.freeze({
  IMAGE: Object.freeze({ model: '{{model}}', prompt: '{{prompt}}', n: 1, size: '{{aspectRatio}}', metadata: { resolution: '{{resolution}}', output_format: 'png' } }),
  // 音乐：上游（Mureka）要求 metadata.lyrics 必填；描述模式下 {{lyrics}} 是平台代写的词，
  // {{style}} 是学生写的描述（当曲风提示词用）。
  MUSIC: Object.freeze({ model: '{{model}}', prompt: '{{style}}', metadata: { lyrics: '{{lyrics}}', n: 1, stream: false } }),
  VIDEO: Object.freeze({ model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationSeconds}}', metadata: { resolution: '{{resolution}}', aspect_ratio: '{{aspectRatio}}', audio: '{{audio}}' } }),
  // 图生视频：上游要的是顶层 image 字段。注意 api.seedance.nz 的报错文案写的是
  // "firstFrameUrl is required"，但实测真正被接受的键是 image（传 firstFrameUrl 反而 400）。
  VIDEO_I2V: Object.freeze({ model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationSeconds}}', image: '{{firstFrameUrl}}', metadata: { resolution: '{{resolution}}', aspect_ratio: '{{aspectRatio}}', audio: '{{audio}}' } }),
  // 首尾帧：尾帧的字段名各家不同（这里按 last_frame 发），不对就到渠道的请求模板里改键名。
  VIDEO_I2V_FRAMES: Object.freeze({ model: '{{model}}', prompt: '{{prompt}}', seconds: '{{durationSeconds}}', image: '{{firstFrameUrl}}', last_frame: '{{lastFrameUrl}}', metadata: { resolution: '{{resolution}}', aspect_ratio: '{{aspectRatio}}', audio: '{{audio}}' } }),
  TEXT: Object.freeze({ model: '{{model}}', messages: [{ role: 'system', content: '你是少儿编程学习平台的创作助手。请用适合儿童理解的方式回答，避免危险或不适龄内容。' }, { role: 'user', content: '{{prompt}}' }] }),
});

// 整串占位符的取值：durationSecondsNumber / n 给数字、audio 给布尔，其余沿用字符串形态
// （老模板里的 seconds: '{{durationSeconds}}' 必须还是 '5'，不能变成数字）。
function typedTemplateValue(key, context) {
  // 上下文里只有 durationSeconds，这个是它的数字形态。
  if (key === 'durationSecondsNumber') return Number(context.durationSeconds) || 0;
  // MiniMax V2 风格的 content 项：有哪张就给哪项，没有就不加（避免发出空 url）。
  if (key === 'frameItems') {
    const items = [];
    const first = String(context.firstFrameUrl || '').trim();
    const last = String(context.lastFrameUrl || '').trim();
    if (first) items.push({ type: 'image_url', image_url: { url: first }, role: 'first_frame' });
    if (last) items.push({ type: 'image_url', image_url: { url: last }, role: 'last_frame' });
    return items;
  }
  if (key === 'referenceItems') {
    // 全能参考：按类型展开成 MiniMax V2 的 content 项（图片 ≤9 / 视频 ≤3 / 音频 ≤3，由服务端限制）
    const assets = Array.isArray(context.referenceAssets) ? context.referenceAssets : [];
    const limits = { IMAGE: 9, VIDEO: 3, AUDIO: 3 };
    const counts = { IMAGE: 0, VIDEO: 0, AUDIO: 0 };
    const items = [];
    for (const asset of assets) {
      const type = String(asset?.type || 'IMAGE').toUpperCase();
      const url = String(asset?.url || '').trim();
      if (!url || !limits[type] || counts[type] >= limits[type]) continue;
      counts[type] += 1;
      if (type === 'IMAGE') items.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
      else if (type === 'VIDEO') items.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
      else items.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
    }
    return items;
  }
  return templateValue(key, context);
}

function templateValue(key, context) {
  const value = context[key];
  // 视频时长沿用改造前的字符串形态（seconds: '5'），避免改动线上请求类型。
  if (key === 'durationSeconds') return String(Number(value) || 0);
  if (key === 'durationSecondsNumber') return Number(context.durationSeconds) || 0;
  if (key === 'n') return Number(value) || 0;
  if (key === 'audio') return value === true;
  // 多轮对话：整串就是 {{messages}} 时返回数组本身（供 chat 类模板使用）。
  if (key === 'messages') return Array.isArray(value) && value.length ? value : '';
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 用模板生成请求体：先解析模板 JSON，再递归替换占位符。
 * 整个字符串就是 {{key}} 时替换为对应类型（数字/布尔），否则做字符串拼接，避免引号把 JSON 弄坏。
 */
export function renderRequestTemplate(template, context) {
  const walk = (node) => {
    // 数组里如果放了会展开成数组的占位符（如 {{frameItems}}），摊平一层，
    // 这样模板可以写成 content: [ {text 项}, "{{frameItems}}" ]。
    if (Array.isArray(node)) return node.flatMap((item) => {
      const walked = walk(item);
      return Array.isArray(walked) ? walked : [walked];
    });
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    if (typeof node !== 'string') return node;
    // 整串就是一个占位符时保留类型：上游要的是数字/布尔，不能变成字符串。
    const exact = node.match(/^\{\{(\w+)\}\}$/);
    if (exact && TEMPLATE_PLACEHOLDERS.includes(exact[1])) return typedTemplateValue(exact[1], context);
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

export function requestTemplateFor(channel, modality, { model = '', requiresFirstFrame = false, withLastFrame = false } = {}) {
  const key = String(modality || '').toUpperCase();
  // 同一个渠道里的模型请求体可能完全不同（hailuo 要顶层 image，MiniMax-H3 V2 要 content[]），
  // 所以模型级模板优先于渠道级。
  const modelTemplate = model ? channel?.modelRequestTemplates?.[String(model).trim()] : null;
  if (modelTemplate && typeof modelTemplate === 'object') return modelTemplate;
  const custom = channel?.requestTemplates?.[key];
  if (custom && typeof custom === 'object') return custom;
  if (key === 'VIDEO' && requiresFirstFrame) {
    return withLastFrame ? DEFAULT_REQUEST_TEMPLATES.VIDEO_I2V_FRAMES : DEFAULT_REQUEST_TEMPLATES.VIDEO_I2V;
  }
  return DEFAULT_REQUEST_TEMPLATES[key] || null;
}

/** 取某模态当前生效的渠道（能力路由里配置的那个）。 */
export function modalityChannel(policy, modality) {
  const key = String(modality || '').toUpperCase();
  const channelId = policy?.modalityChannels?.[key];
  return Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === channelId) || null : null;
}
