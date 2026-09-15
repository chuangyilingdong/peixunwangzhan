// PPTX 渲染：把一份**结构化规格**（JSON）渲染成真正的 .pptx 字节。
//
// 为什么是「规格 → 服务端渲染」而不是「模型写 python-pptx 代码」：
// 我们的服务端没有代码沙箱（2026-09-11 按用户要求删掉了），也不该为了出 PPT 装回来。
// 参考实现 OpenSquilla 里恰好也有一条同样的无沙箱路径（tools/builtin/file_authoring.py 的 create_pptx：
// 收结构化的 slides 数组、进程内渲染），这份是那条路的等价物。
//
// 版面策略：**不用占位符**，每页都放显式的文本框与图片框。
// 占位符要继承 slideLayout/slideMaster 的层级，任何一处不齐就会「能生成、PowerPoint 说文件损坏」；
// 显式形状把依赖压到最低，稳定得多（代价是版式不如模板丰富，这是有意换的）。
import { createZip, xmlEscape, xmlSafe } from './zip.js';

// 16:9，EMU（1 英寸 = 914400 EMU）
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const MARGIN = 685800;        // 0.75 英寸
const CONTENT_W = SLIDE_W - MARGIN * 2;

// 幻灯片里图片关系的固定 id：rId1 被 slideLayout 占着，图片必须是 rId2（写错的话
// 图片形状会指向版式，python-pptx 报 image unreadable、PowerPoint 说文件需要修复）。
const IMAGE_REL_ID = 'rId2';

const FONT = 'Microsoft YaHei';

/**
 * 五套主题色板。模型的规格里可以写 `"theme":"ocean"`；不写就用 ink（原来的那套配色）。
 *
 * ⚠️ 前端 `console/DocumentPreview.jsx` 有一份**同样的**表（站内预览要用同一套颜色，
 * 否则「预览好看、下载出来另一个样」）。两边由 `scripts/p50-theme-parity.mjs` 盯着，改要一起改。
 */
export const THEMES = Object.freeze({
  ink:    Object.freeze({ label: '墨黑橙', bg: 'FFFFFF', ink: '1F2A44', body: '5A6785', accent: 'FF6B2C', soft: 'F3F5FA', cover: '12203F' }),
  ocean:  Object.freeze({ label: '海洋蓝', bg: 'FFFFFF', ink: '0F2B46', body: '4A6076', accent: '1B7FD4', soft: 'E8F1FA', cover: '0C2338' }),
  sunset: Object.freeze({ label: '落日橙', bg: 'FFFFFF', ink: '3A1D18', body: '6B4A3E', accent: 'E4572E', soft: 'FDEDE7', cover: '33150F' }),
  forest: Object.freeze({ label: '森林绿', bg: 'FFFFFF', ink: '12321F', body: '42604C', accent: '2E9E5B', soft: 'E9F6ED', cover: '0E2A1A' }),
  candy:  Object.freeze({ label: '糖果紫', bg: 'FFFFFF', ink: '3C1E3F', body: '6B4A6E', accent: 'D6489B', soft: 'FCEBF6', cover: '2E1430' }),
});
export const DEFAULT_THEME = 'ink';

/** 取主题；名字不认识就回默认（宁可配色不对，也不能让整份 PPT 出错） */
export function themeOf(name) {
  return THEMES[String(name || '').trim().toLowerCase()] || THEMES[DEFAULT_THEME];
}

/**
 * 中文字符的宽度估算（单位：1/100 磅）。
 *
 * 目的不是"排版精确"，而是**别让文字冒出画布**：Office 自己会按框换行，但如果我们给的框太小、
 * 或字号太大，出来的就是「一页字挤成一团/被裁掉」，而文件本身照样"有效"——
 * 又一个不报错的失败。所以按字数估个高度，超了就自动降字号。
 */
function estimateTextHeight(texts, { fontSize, boxWidth, lineSpacing = 1.35 }) {
  const widthPt = (boxWidth / 12700);          // EMU → 磅
  let lines = 0;
  for (const text of texts) {
    const value = String(text || '');
    // 中日韩按 1 个字宽、其他按 0.55 估
    const units = [...value].reduce((sum, char) => sum + (/[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.55), 0);
    const perLine = Math.max(1, (widthPt / (fontSize / 100)) * 0.98);
    lines += Math.max(1, Math.ceil(units / perLine));
  }
  return Math.round(lines * (fontSize / 100) * lineSpacing * 12700);
}

/** 内容页的正文框能放多少字：超了就降档 */
function fitFontSize(texts, { boxWidth, boxHeight }) {
  for (const size of [2000, 1800, 1600, 1450, 1300, 1200]) {
    if (estimateTextHeight(texts, { fontSize: size, boxWidth }) <= boxHeight) return size;
  }
  return 1200;
}

function run(text, { size = 1800, bold = false, color = null, italic = false, theme = null } = {}) {
  const ink = color || (theme || THEMES[DEFAULT_THEME]).ink;
  return `<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${size}"${bold ? ' b="1"' : ''}${italic ? ' i="1"' : ''} dirty="0">`
    + `<a:solidFill><a:srgbClr val="${ink}"/></a:solidFill>`
    + `<a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface="${FONT}"/></a:rPr>`
    + `<a:t>${xmlEscape(xmlSafe(text))}</a:t></a:r>`;
}

function paragraph(text, options = {}) {
  const { bullets = false, align = 'l', spaceBefore = 0, lineSpacing = null, theme = THEMES[DEFAULT_THEME] } = options;
  // a:pPr 的子元素顺序是 schema 规定的：lnSpc → spcBef → spcAft → buClr → buFont → buChar/buNone。
  // 顺序错了 PowerPoint 可能照样打开、也可能直接说文件损坏，所以严格按序拼。
  const parts = [`<a:pPr algn="${align}">`];
  if (lineSpacing) parts.push(`<a:lnSpc><a:spcPct val="${lineSpacing}"/></a:lnSpc>`);
  parts.push(`<a:spcBef><a:spcPts val="${spaceBefore}"/></a:spcBef>`);
  parts.push(bullets
    ? `<a:buClr><a:srgbClr val="${theme.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/>`
    : '<a:buNone/>');
  parts.push('</a:pPr>');
  return `<a:p>${parts.join('')}${text ? run(text, options) : ''}</a:p>`;
}

/** 一个显式文本框 */
function textBox({ id, name, x, y, cx, cy, paragraphs, anchor = 't' }) {
  return '<p:sp><p:nvSpPr>'
    + `<p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/>`
    + '</p:nvSpPr><p:spPr>'
    + `<a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>'
    + '</p:spPr><p:txBody>'
    + `<a:bodyPr wrap="square" lIns="0" rIns="0" tIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>`
    + paragraphs.join('')
    + '</p:txBody></p:sp>';
}

function picture({ id, name, x, y, cx, cy, rId }) {
  return '<p:pic><p:nvPicPr>'
    + `<p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/>`
    + '</p:nvPicPr>'
    + `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}

/** 封面图在 generatedImages 里的保留下标（幻灯片是 0..n，封面不与它们冲突） */
export const COVER_IMAGE_KEY = -1;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_SIG = Buffer.from('GIF8', 'ascii');

/** 图片扩展名 → { contentType, extension }；不是认识的图片就返回 null（那一页就不放图） */
function imageType(buffer) {
  if (buffer.subarray(0, 8).equals(PNG_SIG)) return { contentType: 'image/png', extension: 'png' };
  if (buffer.subarray(0, 3).equals(JPEG_SIG)) return { contentType: 'image/jpeg', extension: 'jpg' };
  if (buffer.subarray(0, 4).equals(GIF_SIG)) return { contentType: 'image/gif', extension: 'gif' };
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { contentType: 'image/webp', extension: 'webp' };
  return null;
}

/** 纯色矩形：强调线、色块、蒙层都用它（alpha 为 0~1 时输出半透明） */
function rect({ id, name = 'Rect', x, y, cx, cy, color, alpha = null }) {
  return '<p:sp><p:nvSpPr>'
    + `<p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr/><p:nvPr/>`
    + '</p:nvSpPr><p:spPr>'
    + `<a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
    + `<a:solidFill><a:srgbClr val="${color}">${alpha === null ? '' : `<a:alpha val="${Math.round(alpha * 100000)}"/>`}</a:srgbClr></a:solidFill>`
    + '<a:ln><a:noFill/></a:ln>'
    + '</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>';
}

function backdrop({ id, color }) {
  return rect({ id, name: 'Backdrop', x: 0, y: 0, cx: SLIDE_W, cy: SLIDE_H, color });
}

function slideXml(shapes) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
    + '<p:cSld><p:spTree>'
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
    + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + shapes.join('')
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

function rels(items) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map((item) => '<Relationship Id="' + item.id + '" Type="' + item.type + '" Target="' + xmlEscape(item.target) + '"' + (item.mode ? ' TargetMode="' + item.mode + '"' : '') + '/>').join('')
    + '</Relationships>';
}

const REL = {
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
};

const THEME_PART = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Magic">'
  + '<a:themeElements><a:clrScheme name="Magic">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
  + '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="1F2A44"/></a:dk2><a:lt2><a:srgbClr val="F5F7FB"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="FF6B2C"/></a:accent1><a:accent2><a:srgbClr val="2F6BFF"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="22B573"/></a:accent3><a:accent4><a:srgbClr val="F2C94C"/></a:accent4>'
  + '<a:accent5><a:srgbClr val="9B51E0"/></a:accent5><a:accent6><a:srgbClr val="EB5757"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="2F6BFF"/></a:hlink><a:folHlink><a:srgbClr val="9B51E0"/></a:folHlink>'
  + '</a:clrScheme><a:fontScheme name="Magic">'
  + '<a:majorFont><a:latin typeface="' + FONT + '"/><a:ea typeface="' + FONT + '"/><a:cs typeface=""/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="' + FONT + '"/><a:ea typeface="' + FONT + '"/><a:cs typeface=""/></a:minorFont>'
  + '</a:fontScheme><a:fmtScheme name="Magic">'
  + '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
  + '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
  + '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>'
  + '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
  + '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

const SLIDE_MASTER_PART = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
  + '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
  + '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  + '</p:spTree></p:cSld>'
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
  + '</p:sldMaster>';

const SLIDE_LAYOUT_PART = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">'
  + '<p:cSld name="空白"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

/** 页脚：可选来源 + 右下角页码。来源与页码都不低于 12pt。 */
function footerShapes({ theme, pageNumber, total, source = '' }) {
  const shapes = [];
  if (source) {
    shapes.push(textBox({
      id: 60, name: 'Source', x: MARGIN, y: SLIDE_H - MARGIN - 80000, cx: CONTENT_W * 0.72, cy: 360000,
      paragraphs: [paragraph(`来源：${source}`, { size: 1200, color: theme.body, theme })],
    }));
  }
  shapes.push(textBox({
    id: 61, name: 'PageNumber', x: SLIDE_W - MARGIN - 1200000, y: SLIDE_H - MARGIN - 80000, cx: 1200000, cy: 360000,
    paragraphs: [paragraph(`${pageNumber} / ${total}`, { size: 1200, align: 'r', color: theme.body, theme })],
  }));
  return shapes;
}

function titleShapes(title, { baseId, theme }) {
  return [textBox({
    id: baseId, name: 'Title', x: MARGIN, y: MARGIN, cx: CONTENT_W, cy: 900000,
    paragraphs: [paragraph(title || '', { size: 3600, bold: true, color: theme.ink, theme })],
  })];
}

function quoteLines(text) {
  const value = String(text || '').trim();
  const parts = value.match(/[^，。！？；]+[，。！？；]?/g)?.map((part) => part.trim()).filter(Boolean) || [value];
  if (parts.length <= 1) return parts;
  const lines = [];
  for (const part of parts) {
    const previous = lines[lines.length - 1];
    if (previous && previous.length + part.length <= 16) lines[lines.length - 1] += part;
    else lines.push(part);
  }
  return lines.slice(0, 4);
}

/**
 * 内容页：标题 + 要点（可选配图）。
 * 字号按正文框**自动降档**：宁可小一点，也不让文字冒出画布 —— 溢出不会报错，只会难看。
 */
function contentShapes(slide, { baseId, theme, hasImage, pageNumber, total }) {
  const shapes = [];
  const layout = String(slide.layout || '').toLowerCase();
  const bullets = (Array.isArray(slide.bullets) ? slide.bullets : []).filter((item) => String(item ?? '').trim()).slice(0, 8);

  // 金句页：一句话居中放大（不放标题条，视觉上做一次呼吸）
  if (layout === 'quote') {
    const text = String(slide.title || bullets[0] || '');
    const lines = quoteLines(text);
    const size = lines.length >= 3 ? 2800 : 3400;
    shapes.push(textBox({
      id: baseId, name: 'Quote', x: MARGIN + CONTENT_W * 0.08, y: SLIDE_H * 0.24, cx: CONTENT_W * 0.84, cy: SLIDE_H * 0.5,
      anchor: 'ctr', paragraphs: lines.map((line) => paragraph(line, { size, align: 'ctr', bold: true, color: theme.ink, theme, lineSpacing: 118000 })),
    }));
    return shapes;
  }

  const titleY = MARGIN;
  shapes.push(...titleShapes(slide.title, { baseId, theme }));

  const bodyY = titleY + 1150000;
  const bodyCy = SLIDE_H - bodyY - MARGIN - 200000;

  // 只有图、没有要点：整页铺图 + 底部色带压标题
  if (!bullets.length && hasImage) {
    shapes.push(picture({ id: baseId + 3, name: 'Picture', x: 0, y: 0, cx: SLIDE_W, cy: SLIDE_H, rId: IMAGE_REL_ID }));
    shapes.push(rect({ id: baseId + 4, name: 'Caption', x: 0, y: SLIDE_H - 1500000, cx: SLIDE_W, cy: 1500000, color: theme.cover, alpha: 0.62 }));
    shapes.push(textBox({
      id: baseId + 5, name: 'CaptionText', x: MARGIN, y: SLIDE_H - 1150000, cx: CONTENT_W, cy: 800000,
      anchor: 'ctr', paragraphs: [paragraph(slide.title || '', { size: 2600, bold: true, color: 'FFFFFF', theme })],
    }));
    return shapes;
  }

  const textWidth = hasImage ? CONTENT_W * 0.46 : CONTENT_W;
  if (bullets.length && !hasImage) {
    const rowH = Math.min(900000, bodyCy / bullets.length);
    bullets.forEach((item, index) => {
      const y = bodyY + index * rowH;
      shapes.push(textBox({ id: baseId + 2 + index * 2, name: `BulletNo ${index + 1}`, x: MARGIN, y, cx: 720000, cy: rowH, anchor: 'ctr', paragraphs: [paragraph(String(index + 1).padStart(2, '0'), { size: 1700, bold: true, color: index === 0 ? theme.accent : theme.ink, theme })] }));
      shapes.push(textBox({ id: baseId + 3 + index * 2, name: `Bullet ${index + 1}`, x: MARGIN + 850000, y, cx: CONTENT_W - 850000, cy: rowH, anchor: 'ctr', paragraphs: [paragraph(String(item), { size: 2000, color: theme.body, theme })] }));
      if (index < bullets.length - 1) shapes.push(rect({ id: 40 + index, name: `Separator ${index + 1}`, x: MARGIN + 850000, y: y + rowH - 22000, cx: CONTENT_W - 850000, cy: 12000, color: theme.body, alpha: 0.16 }));
    });
  } else if (bullets.length) {
    const size = fitFontSize(bullets.map(String), { boxWidth: textWidth, boxHeight: bodyCy });
    shapes.push(textBox({
      id: baseId + 2, name: 'Body', x: MARGIN, y: bodyY, cx: textWidth, cy: bodyCy,
      paragraphs: bullets.map((item, index) => paragraph(String(item), {
        size, theme, bullets: true, color: theme.body, spaceBefore: index ? 700 : 0,
      })),
    }));
  }
  if (hasImage) {
    const imageX = MARGIN + textWidth + 320000;
    const imageW = SLIDE_W - MARGIN - imageX;
    const imageH = Math.min(bodyCy, Math.round(imageW * 0.62));
    // 图下垫一块浅色底，成组感更强（也让纯白背景上的图不"飘"）
    shapes.push(rect({ id: baseId + 6, name: 'ImageMat', x: imageX - 60000, y: bodyY - 60000, cx: imageW + 120000, cy: imageH + 120000, color: theme.soft }));
    shapes.push(picture({ id: baseId + 3, name: 'Picture', x: imageX, y: bodyY, cx: imageW, cy: imageH, rId: IMAGE_REL_ID }));
  }
  return shapes;
}

function metricsShapes(slide, { baseId, theme }) {
  const items = Array.isArray(slide.metrics) ? slide.metrics.slice(0, 4) : [];
  const shapes = [
    ...titleShapes(slide.title, { baseId, theme }),
  ];
  const columns = items.length === 3 ? 3 : items.length <= 2 ? Math.max(1, items.length) : 2;
  const rows = Math.ceil(items.length / columns);
  const gap = 220000;
  const cellW = (CONTENT_W - gap * (columns - 1)) / columns;
  const cellH = (SLIDE_H - MARGIN * 2 - 1500000 - gap * Math.max(0, rows - 1)) / Math.max(1, rows);
  const valueSize = items.length <= 2 ? 4600 : items.length === 3 ? 4000 : 3800;
  items.forEach((item, index) => {
    const column = index % columns;
    const rowIndex = Math.floor(index / columns);
    const x = MARGIN + column * (cellW + gap);
    const y = MARGIN + 1250000 + rowIndex * (cellH + gap);
    shapes.push(rect({ id: baseId + 2 + index * 3, name: `Metric ${index + 1}`, x, y, cx: cellW, cy: cellH, color: theme.soft }));
    shapes.push(textBox({
      id: baseId + 3 + index * 3, name: `Metric Value ${index + 1}`, x: x + 260000, y: y + cellH * 0.18, cx: cellW - 520000, cy: cellH * 0.38,
      anchor: 'ctr', paragraphs: [paragraph(item.value || '', { size: valueSize, bold: true, color: theme.accent, theme })],
    }));
    shapes.push(textBox({
      id: baseId + 4 + index * 3, name: `Metric Label ${index + 1}`, x: x + 260000, y: y + cellH * 0.6, cx: cellW - 520000, cy: cellH * 0.25,
      paragraphs: [paragraph(item.label || '', { size: 1500, color: theme.body, theme })],
    }));
  });
  return shapes;
}

function timelineShapes(slide, { baseId, theme }) {
  const steps = Array.isArray(slide.steps) ? slide.steps.slice(0, 6) : [];
  const shapes = [...titleShapes(slide.title, { baseId, theme })];
  const x = MARGIN + 300000;
  const y = SLIDE_H * 0.43;
  const width = CONTENT_W - 600000;
  const slot = width / Math.max(1, steps.length);
  if (steps.length > 1) shapes.push(rect({ id: 48, name: 'Timeline', x: x + slot / 2, y, cx: slot * (steps.length - 1), cy: 22000, color: theme.body, alpha: 0.26 }));
  steps.forEach((step, index) => {
    const center = x + slot * index + slot / 2;
    const active = index === steps.length - 1;
    shapes.push(rect({ id: baseId + 2 + index * 2, name: `Step ${index + 1}`, x: center - 180000, y: y - 170000, cx: 360000, cy: 360000, color: active ? theme.accent : theme.ink }));
    shapes.push(textBox({
      id: baseId + 3 + index * 2, name: `Step Text ${index + 1}`, x: center - slot * 0.43, y: y + 350000, cx: slot * 0.86, cy: 1300000,
      paragraphs: [paragraph(String(step), { size: 1450, bold: active, align: 'ctr', color: active ? theme.ink : theme.body, theme })],
    }));
  });
  return shapes;
}

function comparisonShapes(slide, { baseId, theme }) {
  const columns = Array.isArray(slide.columns) ? slide.columns.slice(0, 2) : [];
  const gap = 260000;
  const width = (CONTENT_W - gap) / 2;
  const maxBullets = Math.max(0, ...columns.map((column) => Array.isArray(column.bullets) ? column.bullets.length : 0));
  const bodyH = Math.min(2450000, 900000 + maxBullets * 400000);
  const bodyY = Math.round((SLIDE_H - bodyH) / 2 + 300000);
  const shapes = [
    ...titleShapes(slide.title, { baseId, theme }),
  ];
  columns.forEach((column, index) => {
    const x = MARGIN + index * (width + gap);
    shapes.push(rect({ id: baseId + 2 + index * 3, name: `Column ${index + 1}`, x, y: bodyY, cx: width, cy: bodyH, color: theme.soft, alpha: index === 0 ? null : 0.52 }));
    const bullets = Array.isArray(column.bullets) ? column.bullets : [];
    shapes.push(textBox({
      id: baseId + 3 + index * 3, name: `Column Text ${index + 1}`, x: x + 300000, y: bodyY + 260000, cx: width - 560000, cy: bodyH - 520000,
      anchor: 'ctr', paragraphs: [paragraph(column.title || '', { size: 2100, bold: true, color: theme.ink, theme }), ...bullets.map((item, bulletIndex) => paragraph(String(item), { size: 1450, bullets: true, spaceBefore: bulletIndex ? 500 : 700, color: theme.body, theme }))],
    }));
  });
  return shapes;
}

function chartShapes(slide, { baseId, theme }) {
  const chart = slide.chart || {};
  const labels = Array.isArray(chart.labels) ? chart.labels.slice(0, 7) : [];
  const values = Array.isArray(chart.values) ? chart.values.slice(0, labels.length).map(Number) : [];
  const max = Math.max(...values.map((value) => Math.abs(value)), 1);
  const highlight = Number(chart.highlight);
  const shapes = [...titleShapes(slide.title, { baseId, theme })];
  const chartX = MARGIN + 300000;
  const chartY = MARGIN + 1250000;
  const chartW = CONTENT_W - 600000;
  const chartH = SLIDE_H - chartY - MARGIN - 450000;

  if (chart.type === 'column') {
    const slot = chartW / Math.max(1, labels.length);
    const baseline = chartY + chartH - 500000;
    labels.forEach((label, index) => {
      const value = values[index] || 0;
      const height = Math.max(80000, (Math.abs(value) / max) * (chartH - 1050000));
      const width = Math.min(760000, slot * 0.58);
      const x = chartX + slot * index + (slot - width) / 2;
      const color = index === highlight ? theme.accent : theme.ink;
      shapes.push(rect({ id: baseId + 2 + index * 3, name: `Column ${index + 1}`, x, y: baseline - height, cx: width, cy: height, color, alpha: index === highlight ? null : 0.78 }));
      shapes.push(textBox({ id: baseId + 3 + index * 3, name: `Value ${index + 1}`, x: x - 120000, y: baseline - height - 380000, cx: width + 240000, cy: 320000, paragraphs: [paragraph(`${value}${chart.unit || ''}`, { size: 1400, bold: index === highlight, align: 'ctr', color, theme })] }));
      shapes.push(textBox({ id: baseId + 4 + index * 3, name: `Label ${index + 1}`, x: chartX + slot * index, y: baseline + 100000, cx: slot, cy: 420000, paragraphs: [paragraph(label, { size: 1200, align: 'ctr', color: theme.body, theme })] }));
    });
    shapes.push(rect({ id: 48, name: 'Baseline', x: chartX, y: baseline, cx: chartW, cy: 16000, color: theme.body, alpha: 0.28 }));
    return shapes;
  }

  const rowH = chartH / Math.max(1, labels.length);
  const labelW = Math.min(1900000, chartW * 0.22);
  const barX = chartX + labelW;
  const barW = chartW - labelW - 1100000;
  labels.forEach((label, index) => {
    const value = values[index] || 0;
    const y = chartY + rowH * index + rowH * 0.2;
    const height = rowH * 0.46;
    const width = Math.max(100000, (Math.abs(value) / max) * barW);
    const color = index === highlight ? theme.accent : theme.ink;
    shapes.push(textBox({ id: baseId + 2 + index * 3, name: `Label ${index + 1}`, x: chartX, y, cx: labelW - 160000, cy: height, anchor: 'ctr', paragraphs: [paragraph(label, { size: 1400, align: 'r', color: theme.body, theme })] }));
    shapes.push(rect({ id: baseId + 3 + index * 3, name: `Bar ${index + 1}`, x: barX, y, cx: width, cy: height, color, alpha: index === highlight ? null : 0.78 }));
    shapes.push(textBox({ id: baseId + 4 + index * 3, name: `Value ${index + 1}`, x: barX + width + 120000, y, cx: 1000000, cy: height, anchor: 'ctr', paragraphs: [paragraph(`${value}${chart.unit || ''}`, { size: 1400, bold: index === highlight, color, theme })] }));
  });
  return shapes;
}

function tableShapes(slide, { baseId, theme }) {
  const table = slide.table || {};
  const headers = Array.isArray(table.headers) ? table.headers.slice(0, 5) : [];
  const rows = Array.isArray(table.rows) ? table.rows.slice(0, 6).map((row) => Array.isArray(row) ? row.slice(0, headers.length) : []) : [];
  const shapes = [...titleShapes(slide.title, { baseId, theme })];
  const x = MARGIN;
  const y = MARGIN + 1250000;
  const width = CONTENT_W;
  const height = SLIDE_H - y - MARGIN - 430000;
  const rowH = height / Math.max(1, rows.length + 1);
  const colW = width / Math.max(1, headers.length);
  shapes.push(rect({ id: baseId + 1, name: 'HeaderBg', x, y, cx: width, cy: rowH, color: theme.ink }));
  headers.forEach((header, column) => shapes.push(textBox({
    id: baseId + 2 + column, name: `Header ${column + 1}`, x: x + colW * column + 140000, y, cx: colW - 280000, cy: rowH,
    anchor: 'ctr', paragraphs: [paragraph(header, { size: 1400, bold: true, color: 'FFFFFF', theme })],
  })));
  rows.forEach((row, rowIndex) => {
    const rowY = y + rowH * (rowIndex + 1);
    if (rowIndex % 2 === 0) shapes.push(rect({ id: 12 + rowIndex, name: `Row ${rowIndex + 1}`, x, y: rowY, cx: width, cy: rowH, color: theme.soft }));
    row.forEach((cell, column) => shapes.push(textBox({
      id: 20 + rowIndex * headers.length + column, name: `Cell ${rowIndex + 1}-${column + 1}`,
      x: x + colW * column + 140000, y: rowY, cx: colW - 280000, cy: rowH,
      anchor: 'ctr', paragraphs: [paragraph(cell, { size: 1250, bold: column === 0, color: column === 0 ? theme.ink : theme.body, theme })],
    })));
  });
  return shapes;
}

function processShapes(slide, { baseId, theme }) {
  const items = Array.isArray(slide.process) ? slide.process.slice(0, 5) : [];
  const shapes = [...titleShapes(slide.title, { baseId, theme })];
  const x = MARGIN + 200000;
  const y = MARGIN + 1900000;
  const width = CONTENT_W - 400000;
  const slot = width / Math.max(1, items.length);
  const node = Math.min(620000, slot * 0.46);
  if (items.length > 1) shapes.push(rect({ id: 48, name: 'ProcessLine', x: x + slot / 2, y: y + node / 2 - 12000, cx: slot * (items.length - 1), cy: 24000, color: theme.body, alpha: 0.3 }));
  items.forEach((item, index) => {
    const center = x + slot * index + slot / 2;
    shapes.push(rect({ id: baseId + 2 + index * 3, name: `Process ${index + 1}`, x: center - node / 2, y, cx: node, cy: node, color: index === items.length - 1 ? theme.accent : theme.ink }));
    shapes.push(textBox({ id: baseId + 3 + index * 3, name: `ProcessNo ${index + 1}`, x: center - node / 2, y, cx: node, cy: node, anchor: 'ctr', paragraphs: [paragraph(String(index + 1).padStart(2, '0'), { size: 1800, bold: true, align: 'ctr', color: 'FFFFFF', theme })] }));
    shapes.push(textBox({ id: baseId + 4 + index * 3, name: `ProcessText ${index + 1}`, x: center - slot * 0.43, y: y + node + 250000, cx: slot * 0.86, cy: 1450000, paragraphs: [paragraph(item.title || '', { size: 1600, bold: true, align: 'ctr', color: theme.ink, theme }), ...(item.detail ? [paragraph(item.detail, { size: 1200, align: 'ctr', color: theme.body, spaceBefore: 500, theme })] : [])] }));
  });
  return shapes;
}

function sectionShapes(slide, { baseId, theme, topics = [] }) {
  const matched = String(slide.title || '').match(/^\s*(\d{1,2})[\s、.：:-]*(.*)$/);
  const sectionNo = matched ? matched[1].padStart(2, '0') : '';
  const sectionTitle = matched?.[2] || slide.title || '';
  const shapes = [
    backdrop({ id: baseId, color: theme.cover }),
    textBox({
      id: baseId + 1, name: 'SectionNo', x: MARGIN, y: SLIDE_H * 0.22, cx: CONTENT_W * 0.18, cy: 1500000,
      paragraphs: [paragraph(sectionNo || '•', { size: 7200, bold: true, color: theme.accent, theme })],
    }),
    textBox({
      id: baseId + 2, name: 'SectionTitle', x: MARGIN, y: SLIDE_H * 0.43, cx: CONTENT_W * 0.52, cy: 1500000,
      paragraphs: [paragraph(sectionTitle, { size: 4000, bold: true, color: 'FFFFFF', theme })],
    }),
  ];
  if (topics.length) {
    shapes.push(textBox({
      id: baseId + 3, name: 'SectionTopics', x: SLIDE_W * 0.63, y: SLIDE_H * 0.34, cx: SLIDE_W * 0.28, cy: SLIDE_H * 0.38,
      anchor: 'ctr', paragraphs: topics.map((topic, index) => paragraph(`${String(index + 1).padStart(2, '0')}  ${topic}`, { size: 1500, color: index === 0 ? 'FFFFFF' : theme.soft, bold: index === 0, spaceBefore: index ? 900 : 0, theme })),
    }));
  }
  return shapes;
}

/** 结尾页 */
function thanksShapes(deck, { baseId, theme }) {
  return [
    backdrop({ id: baseId, color: theme.cover }),
    textBox({
      id: baseId + 1, name: 'Thanks', x: 0, y: SLIDE_H * 0.36, cx: SLIDE_W, cy: 1500000,
      anchor: 'ctr', paragraphs: [paragraph('谢谢观看', { size: 4000, align: 'ctr', bold: true, color: 'FFFFFF', theme })],
    }),
    textBox({
      id: baseId + 2, name: 'ThanksSub', x: 0, y: SLIDE_H * 0.56, cx: SLIDE_W, cy: 700000,
      anchor: 'ctr', paragraphs: [paragraph(deck.title || '', { size: 1800, align: 'ctr', color: theme.soft, theme })],
    }),
  ];
}

/**
 * 封面：有封面图就整页铺图 + 压一层深色蒙层（像正经演示稿那样），没有就走纯色版。
 * 蒙层是必需的 —— 白字直接压在照片上十有八九看不清。
 */
function coverShapes(deck, { theme, hasImage, topics = [] }) {
  const shapes = [];
  if (hasImage) {
    shapes.push(picture({ id: 2, name: 'CoverImage', x: 0, y: 0, cx: SLIDE_W, cy: SLIDE_H, rId: IMAGE_REL_ID }));
    shapes.push(rect({ id: 3, name: 'CoverScrim', x: 0, y: 0, cx: SLIDE_W, cy: SLIDE_H, color: theme.cover, alpha: 0.58 }));
  } else {
    shapes.push(backdrop({ id: 2, color: theme.cover }));
  }
  shapes.push(textBox({
    id: 4, name: 'CoverTitle', x: MARGIN, y: SLIDE_H * 0.25, cx: hasImage ? CONTENT_W * 0.78 : CONTENT_W * 0.54, cy: 1800000,
    paragraphs: [paragraph(deck.title || '演示文稿', { size: 4400, bold: true, color: 'FFFFFF', theme })],
  }));
  if (deck.subtitle) {
    shapes.push(textBox({
      id: 5, name: 'CoverSubtitle', x: MARGIN, y: SLIDE_H * 0.25 + 1900000, cx: hasImage ? CONTENT_W * 0.72 : CONTENT_W * 0.52, cy: 900000,
      paragraphs: [paragraph(deck.subtitle, { size: 2000, color: theme.soft, theme })],
    }));
  }
  if (deck.author) {
    shapes.push(textBox({
      id: 6, name: 'CoverAuthor', x: MARGIN, y: SLIDE_H * 0.67, cx: CONTENT_W * 0.52, cy: 400000,
      paragraphs: [paragraph(deck.author, { size: 1400, color: theme.soft, theme })],
    }));
  }
  if (!hasImage && topics.length) {
    shapes.push(textBox({
      id: 7, name: 'CoverTopics', x: SLIDE_W * 0.65, y: SLIDE_H * 0.3, cx: SLIDE_W * 0.27, cy: SLIDE_H * 0.4,
      anchor: 'ctr', paragraphs: topics.map((topic, index) => paragraph(`${String(index + 1).padStart(2, '0')}  ${topic}`, { size: 1450, color: index === 0 ? 'FFFFFF' : theme.soft, bold: index === 0, spaceBefore: index ? 900 : 0, theme })),
    }));
  }
  return shapes;
}

export function renderPptx(deck, { attachmentImages = new Map(), generatedImages = new Map() } = {}) {
  const slides = Array.isArray(deck?.slides) ? deck.slides : [];
  const theme = themeOf(deck?.theme);
  const slideParts = [];
  // 页码按「实际会出现的页数」算：封面 + 内容页 + 结尾页（如果模型要了）
  const total = 1 + slides.length;

  // 封面：封面图单独一个槽位（generatedImages 用 -1 表示），它也算进「最多 3 张」
  const coverBuffer = generatedImages.get(COVER_IMAGE_KEY) || null;
  const coverType = coverBuffer ? imageType(coverBuffer) : null;
  const coverTopics = slides.filter((slide) => !['section', 'thanks'].includes(String(slide?.layout || '').toLowerCase()) && slide?.title).slice(0, 3).map((slide) => slide.title);
  slideParts.push({ xml: slideXml(coverShapes(deck, { theme, hasImage: Boolean(coverType), topics: coverTopics })), image: coverType ? { buffer: coverBuffer, ...coverType } : null });

  // 内容页：优先用平台生成的插画，其次用学生自己传的图
  slides.forEach((slide, index) => {
    const layout = String(slide?.layout || '').toLowerCase();
    if (layout === 'thanks') {
      slideParts.push({ xml: slideXml(thanksShapes(deck, { baseId: 2, theme })), image: null });
      return;
    }
    if (layout === 'section') {
      const topics = [];
      for (let cursor = index + 1; cursor < slides.length && topics.length < 3; cursor += 1) {
        const candidate = slides[cursor];
        if (['section', 'thanks'].includes(String(candidate?.layout || '').toLowerCase())) break;
        if (candidate?.title) topics.push(candidate.title);
      }
      slideParts.push({ xml: slideXml(sectionShapes(slide, { baseId: 2, theme, pageNumber: index + 2, topics })), image: null });
      return;
    }
    if (layout === 'metrics') {
      slideParts.push({ xml: slideXml([...metricsShapes(slide, { baseId: 2, theme }), ...footerShapes({ theme, pageNumber: index + 2, total, source: slide.source })]), image: null });
      return;
    }
    if (layout === 'timeline') {
      slideParts.push({ xml: slideXml([...timelineShapes(slide, { baseId: 2, theme }), ...footerShapes({ theme, pageNumber: index + 2, total, source: slide.source })]), image: null });
      return;
    }
    if (layout === 'comparison') {
      slideParts.push({ xml: slideXml([...comparisonShapes(slide, { baseId: 2, theme }), ...footerShapes({ theme, pageNumber: index + 2, total, source: slide.source })]), image: null });
      return;
    }
    if (layout === 'chart') {
      slideParts.push({ xml: slideXml([...chartShapes(slide, { baseId: 2, theme }), ...footerShapes({ theme, pageNumber: index + 2, total, source: slide.source })]), image: null });
      return;
    }
    if (layout === 'table') {
      slideParts.push({ xml: slideXml([...tableShapes(slide, { baseId: 2, theme }), ...footerShapes({ theme, pageNumber: index + 2, total, source: slide.source })]), image: null });
      return;
    }
    if (layout === 'process') {
      slideParts.push({ xml: slideXml([...processShapes(slide, { baseId: 2, theme }), ...footerShapes({ theme, pageNumber: index + 2, total, source: slide.source })]), image: null });
      return;
    }
    const buffer = generatedImages.get(index) || (slide.imageAttachment ? attachmentImages.get(slide.imageAttachment) : null);
    const type = buffer ? imageType(buffer) : null;
    // 生成失败、引用越界、素材读不到、格式不是图片 —— 都只是**这一页不放图**，不让整份 PPT 失败
    const shapes = contentShapes(slide, { baseId: 2, theme, hasImage: Boolean(type), pageNumber: index + 2, total });
    // 金句页/整页图页不加页码（它们本身就是视觉停顿）
    const bare = layout === 'quote' || (!type && !(slide.bullets || []).length);
    slideParts.push({
      xml: slideXml(bare ? shapes : [...shapes, ...footerShapes({ theme, pageNumber: index + 2, total, source: slide.source })]),
      image: type ? { buffer, ...type } : null,
    });
  });

  const imageExtensions = new Set(slideParts.filter((part) => part.image).map((part) => part.image.extension));

  const entries = [];
  const presentationIds = [];
  // [Content_Types].xml 必须是包里的第一个条目
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + [...imageExtensions].map((ext) => `<Default Extension="${ext}" ContentType="image/${ext === 'jpg' ? 'jpeg' : ext}"/>`).join('')
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + slideParts.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
    + '</Types>';
  entries.push({ name: '[Content_Types].xml', data: contentTypes });
  entries.push({
    name: '_rels/.rels',
    data: rels([{ id: 'rId1', type: REL.officeDocument, target: 'ppt/presentation.xml' }]),
  });
  entries.push({ name: 'ppt/theme/theme1.xml', data: THEME_PART });
  entries.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER_PART });
  entries.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    data: rels([
      { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: REL.theme, target: '../theme/theme1.xml' },
    ]),
  });
  entries.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT_PART });
  entries.push({
    name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    data: rels([{ id: 'rId1', type: REL.slideMaster, target: '../slideMasters/slideMaster1.xml' }]),
  });

  slideParts.forEach((part, index) => {
    const number = index + 1;
    entries.push({ name: `ppt/slides/slide${number}.xml`, data: part.xml });
    const slideRels = [{ id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' }];
    if (part.image) {
      slideRels.push({ id: 'rId2', type: REL.image, target: `../media/image${number}.${part.image.extension}` });
      entries.push({ name: `ppt/media/image${number}.${part.image.extension}`, data: part.image.buffer, store: true });
    }
    entries.push({ name: `ppt/slides/_rels/slide${number}.xml.rels`, data: rels(slideRels) });
    presentationIds.push(`<p:sldId id="${256 + number}" r:id="rId${number + 1}"/>`);
  });

  entries.push({
    name: 'ppt/presentation.xml',
    data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">'
      + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
      + `<p:sldIdLst>${presentationIds.join('')}</p:sldIdLst>`
      + `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/>`
      + '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
  });
  entries.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: rels([
      { id: 'rId1', type: REL.slideMaster, target: 'slideMasters/slideMaster1.xml' },
      ...slideParts.map((_, index) => ({ id: `rId${index + 2}`, type: REL.slide, target: `slides/slide${index + 1}.xml` })),
      { id: `rId${slideParts.length + 2}`, type: REL.theme, target: 'theme/theme1.xml' },
    ]),
  });

  return { buffer: createZip(entries), slideCount: slideParts.length };
}
