// 文档产物（pptx / docx / xlsx）：产物里存的是**规格文本**，下载的那一刻才渲染成真正的文件。
//
// 为什么不把二进制存进产物表：产物内容是一列 TEXT、有 256KB 上限、还要参与版本比对与「源码」视图；
// 而 docx/xlsx/pptx 是 zip，base64 之后又大又不可读。存规格的好处是**天然的**：
//   · 学生能在工作台「源码」里看懂自己那份文档是怎么写的（CSV/Markdown/JSON）
//   · 版本/大小/配额全都沿用产物现有的口径
//   · 渲染器升级后，老产物重新下载就能受益
// 代价是每次下载要渲染一次（几毫秒），完全可接受。
import { renderPptx } from './pptx.js';
import { renderDocx } from './docx.js';
import { renderXlsx } from './xlsx.js';

export const DOCUMENT_KINDS = Object.freeze(['pptx', 'docx', 'xlsx']);

const MIME = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function isDocumentKind(kind) {
  return DOCUMENT_KINDS.includes(String(kind || '').toLowerCase());
}

export function documentMime(kind) {
  return MIME[String(kind || '').toLowerCase()] || 'application/octet-stream';
}

/** 规格文本里的控制字符会污染 XML，进渲染器前先做一次粗筛 */
function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/**
 * 把产物的规格文本解析成 deck 结构。
 * 模型偶尔会多包一层 markdown 围栏或前后加解释，这里做**宽容解析**：
 * 找到第一段能解析成对象的 JSON 就用它，而不是直接失败。
 */
export function parseDeckSpec(content) {
  const text = cleanText(content).trim();
  const candidates = [text];
  // 去掉可能的 ```json 围栏
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fenced) candidates.unshift(fenced[1]);
  // 退一步：从第一个 { 到最后一个 }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(text.slice(firstBrace, lastBrace + 1));

  for (const candidate of candidates) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const slides = Array.isArray(parsed.slides) ? parsed.slides : [];
    if (!slides.length) continue;
    return {
      title: cleanText(parsed.title || '').slice(0, 200),
      subtitle: cleanText(parsed.subtitle || '').slice(0, 300),
      author: cleanText(parsed.author || '').slice(0, 120),
      slides: slides.slice(0, MAX_SLIDES).map((slide) => ({
        title: cleanText(slide?.title || '').slice(0, 200),
        bullets: (Array.isArray(slide?.bullets) ? slide.bullets : [])
          .map((item) => cleanText(item).slice(0, 500)).filter((item) => item.trim()).slice(0, 12),
        // 配图有两个来源：
        //   ① {"attachment": N} —— 学生这一轮自己传的第 N 张图；
        //   ② {"prompt": "..."} —— 让**平台生成**一张插画（图由 AI 渠道出，见 vibecodingIllustrations）。
        // 都不给或取不到时那一页就不放图，不整份失败。
        imageAttachment: (() => {
          const raw = slide?.image?.attachment ?? slide?.imageAttachment;
          const value = Number(raw);
          return Number.isInteger(value) && value >= 1 && value <= 20 ? value : null;
        })(),
        imagePrompt: cleanText(slide?.image?.prompt || slide?.imagePrompt || '').trim().slice(0, 300) || null,
      })).filter((slide) => slide.title || slide.bullets.length || slide.imageAttachment || slide.imagePrompt),
    };
  }
  return null;
}

/** 一份 deck 里要求「生成」的插画（按页序），给生成流程用 */
export function deckIllustrationRequests(deck) {
  const slides = Array.isArray(deck?.slides) ? deck.slides : [];
  return slides
    .map((slide, index) => ({ slideIndex: index, prompt: String(slide?.imagePrompt || '').trim() }))
    .filter((item) => item.prompt);
}

export const MAX_SLIDES = 40;

/**
 * 渲染一份文档产物。
 * @param {object} artifact { kind, content, name }
 * @param {{attachmentImages?: Map<number, Buffer>, generatedImages?: Map<number, Buffer>}} options
 *        attachmentImages = 附件序号 → 图片字节；generatedImages = 幻灯片下标 → 生成出来的插画字节
 * @returns {{buffer: Buffer, mime: string, filename: string} | {error: string}}
 */
export function renderDocument(artifact, { attachmentImages = new Map(), generatedImages = new Map() } = {}) {
  const kind = String(artifact?.kind || '').toLowerCase();
  const content = String(artifact?.content ?? '');
  if (!isDocumentKind(kind)) return { error: '不是可渲染的文档产物' };
  try {
    if (kind === 'pptx') {
      const deck = parseDeckSpec(content);
      if (!deck) return { error: '这份 PPT 的内容不是可识别的规格（需要 JSON，且至少有一页 slides）' };
      const { buffer } = renderPptx(deck, { attachmentImages, generatedImages });
      return { buffer, mime: MIME.pptx, filename: artifact.name };
    }
    if (kind === 'docx') {
      const { buffer } = renderDocx(content, { title: artifact.name?.replace(/\.docx$/i, '') || '文档' });
      return { buffer, mime: MIME.docx, filename: artifact.name };
    }
    const { buffer } = renderXlsx(content, { sheetName: artifact.name?.replace(/\.xlsx$/i, '') || '工作表' });
    return { buffer, mime: MIME.xlsx, filename: artifact.name };
  } catch (error) {
    return { error: `渲染失败：${String(error?.message || error)}` };
  }
}
