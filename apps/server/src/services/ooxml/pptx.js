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
const COLORS = { ink: '1F2A44', muted: '5A6785', accent: 'FF6B2C', line: 'E4E8F0', cover: '12203F' };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_SIG = Buffer.from('GIF8', 'ascii');

/** 图片扩展名 → [内容类型, zip 里的默认扩展名] */
function imageType(buffer) {
  if (buffer.subarray(0, 8).equals(PNG_SIG)) return { contentType: 'image/png', extension: 'png' };
  if (buffer.subarray(0, 3).equals(JPEG_SIG)) return { contentType: 'image/jpeg', extension: 'jpg' };
  if (buffer.subarray(0, 4).equals(GIF_SIG)) return { contentType: 'image/gif', extension: 'gif' };
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { contentType: 'image/webp', extension: 'webp' };
  return null;
}

function run(text, { size = 1800, bold = false, color = COLORS.ink, italic = false } = {}) {
  return `<a:r><a:rPr lang="zh-CN" altLang="en-US" sz="${size}"${bold ? ' b="1"' : ''}${italic ? ' i="1"' : ''} dirty="0">`
    + `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
    + `<a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface="${FONT}"/></a:rPr>`
    + `<a:t>${xmlEscape(xmlSafe(text))}</a:t></a:r>`;
}

function paragraph(text, options = {}) {
  const { bullets = false, align = 'l', spaceBefore = 0, lineSpacing = null } = options;
  // a:pPr 的子元素顺序是 schema 规定的：lnSpc → spcBef → spcAft → buClr → buFont → buChar/buNone。
  // 顺序错了 PowerPoint 可能照样打开、也可能直接说文件损坏，所以严格按序拼。
  const parts = [`<a:pPr algn="${align}">`];
  if (lineSpacing) parts.push(`<a:lnSpc><a:spcPct val="${lineSpacing}"/></a:lnSpc>`);
  parts.push(`<a:spcBef><a:spcPts val="${spaceBefore}"/></a:spcBef>`);
  parts.push(bullets
    ? `<a:buClr><a:srgbClr val="${COLORS.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/>`
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

/** 一根细的强调线（封面用），做成矩形填充 */
function bar({ id, x, y, cx, cy, color = COLORS.accent }) {
  return '<p:sp><p:nvSpPr>'
    + `<p:cNvPr id="${id}" name="Bar${id}"/><p:cNvSpPr/><p:nvPr/>`
    + '</p:nvSpPr><p:spPr>'
    + `<a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>`
    + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln>`
    + '</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>';
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

function plainSlideXml() {
  return slideXml([]);
}

const THEME = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Magic">'
  + '<a:themeElements>'
  + '<a:clrScheme name="Magic">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
  + '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="1F2A44"/></a:dk2><a:lt2><a:srgbClr val="F5F7FB"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="FF6B2C"/></a:accent1><a:accent2><a:srgbClr val="2F6BFF"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="22B573"/></a:accent3><a:accent4><a:srgbClr val="F2C94C"/></a:accent4>'
  + '<a:accent5><a:srgbClr val="9B51E0"/></a:accent5><a:accent6><a:srgbClr val="EB5757"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="2F6BFF"/></a:hlink><a:folHlink><a:srgbClr val="9B51E0"/></a:folHlink>'
  + '</a:clrScheme>'
  + '<a:fontScheme name="Magic">'
  + `<a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface=""/></a:majorFont>`
  + `<a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface=""/></a:minorFont>`
  + '</a:fontScheme>'
  + '<a:fmtScheme name="Magic">'
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

const SLIDE_MASTER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
  + '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
  + '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  + '</p:spTree></p:cSld>'
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" '
  + 'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
  + '</p:sldMaster>';

const SLIDE_LAYOUT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">'
  + '<p:cSld name="空白"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

function rels(items) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + items.map((item) => `<Relationship Id="${item.id}" Type="${item.type}" Target="${xmlEscape(item.target)}"${item.mode ? ` TargetMode="${item.mode}"` : ''}/>`).join('')
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

/** 一页的内容 → shapes（不含图片，图片单独回传关系） */
function contentShapes(slide, baseId, hasImage) {
  const shapes = [];
  const titleY = MARGIN;
  shapes.push(textBox({
    id: baseId, name: 'Title', x: MARGIN, y: titleY, cx: CONTENT_W, cy: 900000,
    paragraphs: [paragraph(slide.title || '', { size: 3000, bold: true, color: COLORS.ink })],
  }));
  // 标题下的一根短强调线（比整页横线克制，也更不像「AI 味」）
  shapes.push(bar({ id: baseId + 1, x: MARGIN, y: titleY + 980000, cx: 900000, cy: 45720 }));

  const bodyY = titleY + 1250000;
  const bodyCy = SLIDE_H - bodyY - MARGIN;
  const bullets = Array.isArray(slide.bullets) ? slide.bullets.filter((item) => String(item ?? '').trim()) : [];
  if (!bullets.length && hasImage) {
    // 只有一张图、没有要点：让图占满正文区（配图页），比缩在右半边好看得多
    shapes.push(picture({ id: baseId + 3, name: 'Picture', x: MARGIN, y: bodyY, cx: CONTENT_W, cy: bodyCy, rId: IMAGE_REL_ID }));
    return shapes;
  }
  const textWidth = hasImage ? CONTENT_W * 0.46 : CONTENT_W;
  if (bullets.length) {
    shapes.push(textBox({
      id: baseId + 2, name: 'Body', x: MARGIN, y: bodyY, cx: textWidth, cy: bodyCy,
      paragraphs: bullets.map((item, index) => paragraph(String(item), {
        size: bullets.length > 6 ? 1500 : 1800, bullets: true, color: COLORS.muted, spaceBefore: index ? 700 : 0,
      })),
    }));
  }
  if (hasImage) {
    const imageX = MARGIN + textWidth + 320000;
    const imageW = SLIDE_W - MARGIN - imageX;
    const imageH = Math.min(bodyCy, Math.round(imageW * 0.62));
    shapes.push(picture({
      id: baseId + 3, name: 'Picture', x: imageX, y: bodyY, cx: imageW, cy: imageH, rId: IMAGE_REL_ID,
    }));
  }
  return shapes;
}

/** 封面 */
function coverShapes(deck) {
  const shapes = [];
  shapes.push(bar({ id: 2, x: MARGIN, y: SLIDE_H * 0.34, cx: 900000, cy: 68580 }));
  shapes.push(textBox({
    id: 3, name: 'CoverTitle', x: MARGIN, y: SLIDE_H * 0.38, cx: CONTENT_W * 0.88, cy: 1600000,
    paragraphs: [paragraph(deck.title || '演示文稿', { size: 4400, bold: true, color: COLORS.cover })],
  }));
  if (deck.subtitle) {
    shapes.push(textBox({
      id: 4, name: 'CoverSubtitle', x: MARGIN, y: SLIDE_H * 0.38 + 1700000, cx: CONTENT_W * 0.8, cy: 900000,
      paragraphs: [paragraph(deck.subtitle, { size: 2000, color: COLORS.muted })],
    }));
  }
  if (deck.author) {
    shapes.push(textBox({
      id: 5, name: 'CoverAuthor', x: MARGIN, y: SLIDE_H - MARGIN - 500000, cx: CONTENT_W * 0.6, cy: 400000,
      paragraphs: [paragraph(deck.author, { size: 1400, color: COLORS.muted })],
    }));
  }
  return shapes;
}

/**
 * @param {object} deck { title, subtitle, author, slides: [{ title, bullets, imageAttachment }] }
 * @param {Map<number, Buffer>} imagesByAttachment 附件序号 → 图片字节（学生在这一轮里传的第 N 张图）
 */
export function renderPptx(deck, imagesByAttachment = new Map()) {
  const slides = Array.isArray(deck?.slides) ? deck.slides : [];
  const slideParts = [];

  // 封面
  slideParts.push({ xml: slideXml(coverShapes(deck)), image: null });
  // 内容页
  slides.forEach((slide) => {
    const buffer = slide.imageAttachment ? imagesByAttachment.get(slide.imageAttachment) : null;
    const type = buffer ? imageType(buffer) : null;
    // 引用越界、素材读不到、格式不是图片 —— 都只是**这一页不放图**，不让整份 PPT 失败
    if (!type) {
      slideParts.push({ xml: slideXml(contentShapes(slide, 2, false)), image: null });
      return;
    }
    slideParts.push({ xml: slideXml(contentShapes(slide, 2, true)), image: { buffer, ...type } });
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
  entries.push({ name: 'ppt/theme/theme1.xml', data: THEME });
  entries.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: SLIDE_MASTER });
  entries.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    data: rels([
      { id: 'rId1', type: REL.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: REL.theme, target: '../theme/theme1.xml' },
    ]),
  });
  entries.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: SLIDE_LAYOUT });
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
