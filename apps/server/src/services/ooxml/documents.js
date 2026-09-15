// 文档产物（pptx / docx / xlsx）：产物里存规格文本，下载时渲染成真正的 Office 文件。
import { deckIllustrationRequests as sharedIllustrationRequests, inspectDeckQuality, parseDeckSpec } from '../../../../../packages/shared/src/deckSpec.js';
import { COVER_IMAGE_KEY, renderPptx } from './pptx.js';
import { renderDocx } from './docx.js';
import { renderXlsx } from './xlsx.js';

export { inspectDeckQuality, parseDeckSpec };
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

export function deckIllustrationRequests(deck) {
  return sharedIllustrationRequests(deck, COVER_IMAGE_KEY);
}

/**
 * @returns {{buffer: Buffer, mime: string, filename: string, quality?: object} | {error: string, quality?: object}}
 */
export function renderDocument(artifact, { attachmentImages = new Map(), generatedImages = new Map() } = {}) {
  const kind = String(artifact?.kind || '').toLowerCase();
  const content = String(artifact?.content ?? '');
  if (!isDocumentKind(kind)) return { error: '不是可渲染的文档产物' };
  try {
    if (kind === 'pptx') {
      const deck = parseDeckSpec(content);
      if (!deck) return { error: '这份 PPT 的内容不是可识别的规格（需要 JSON，且至少有一页 slides）' };
      const quality = inspectDeckQuality(deck);
      if (!quality.pass) {
        const reasons = quality.issues.filter((issue) => issue.level === 'error').map((issue) => `第 ${issue.page} 页 ${issue.message}`).join('；');
        return { error: `PPT 质量检查未通过：${reasons}`, quality };
      }
      const { buffer } = renderPptx(deck, { attachmentImages, generatedImages });
      return { buffer, mime: MIME.pptx, filename: artifact.name, quality };
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
