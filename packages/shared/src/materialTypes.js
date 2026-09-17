/**
 * 课堂素材「类型 → 图标 / 名字 / 色调」的唯一映射（2026-09-17）。
 *
 * 为什么要单独一份：同一个素材类型出现在三个地方 —— 学生端左侧列表、老师端课包配置、
 * 画布上的框体。以前只有画布框体按类型分了色（图=天蓝 / 视频=紫 / 音频=粉），
 * 而左侧列表与老师端下拉全是同一个绿图标 + 一行文字，于是「生图框体、生视频框体、
 * 生音乐框体」在这些地方根本分不出来（用户 2026-09-17 报的第 2 条）。
 * 现在三处都走这一份映射，色调沿用画布框体那套（`styles.css` 里 `.learning-node--*`
 * 的蓝 / 紫 / 粉），学生与老师看到的是同一套语言。
 *
 * ⚠️ 生成框体（GENERATION_BOX）本身是一种素材类型，但它的**身份要看模态**：
 * 生图框体 / 生视频框体 / 生音乐框体 / 生文字框体 —— 所以这里按 modality 再分一层。
 */

/** 类型图标与名字（素材表里的 material_type）。 */
const BY_MATERIAL_TYPE = {
  IMAGE: { icon: 'image', label: '图片', tone: 'image' },
  VIDEO: { icon: 'video', label: '视频', tone: 'video' },
  AUDIO: { icon: 'music', label: '音频', tone: 'audio' },
  PROMPT: { icon: 'text', label: '提示词', tone: 'prompt' },
  NOTE: { icon: 'text', label: '文字', tone: 'prompt' },
};

/** 生成框体按模态分（学生看到的是「生图框体」而不是笼统的「生成框体」）。 */
const BY_BOX_MODALITY = {
  IMAGE: { icon: 'image', label: '生图框体', tone: 'image' },
  VIDEO: { icon: 'video', label: '生视频框体', tone: 'video' },
  MUSIC: { icon: 'music', label: '生音乐框体', tone: 'audio' },
  TEXT: { icon: 'text', label: '生文字框体', tone: 'prompt' },
};

/** 兜底：没写类型的老素材按提示词处理（与老师端 currentType 的兜底口径一致）。 */
const FALLBACK = { icon: 'spark', label: '素材', tone: 'prompt' };

/**
 * 取一份素材的视觉信息。
 * @param {{materialType?: string, modality?: string}} material - 素材（生成框体额外给 box.modality）
 * @returns {{icon: string, label: string, tone: 'image'|'video'|'audio'|'prompt'}} 图标名 / 中文名 / 色调
 */
export function materialVisual({ materialType, modality } = {}) {
  const type = String(materialType || 'PROMPT').trim().toUpperCase();
  if (type === 'GENERATION_BOX') {
    return BY_BOX_MODALITY[String(modality || 'TEXT').trim().toUpperCase()] || BY_BOX_MODALITY.TEXT;
  }
  return BY_MATERIAL_TYPE[type] || FALLBACK;
}

/** 色调对应的 CSS 类名后缀（`is-image` / `is-video` / …）。 */
export function materialToneClass(material) {
  return `is-${materialVisual(material).tone}`;
}
