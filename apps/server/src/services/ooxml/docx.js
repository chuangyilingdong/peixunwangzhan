// DOCX 渲染：把 **Markdown 子集**渲染成真正的 .docx 字节。
//
// 为什么用 Markdown 而不是 JSON：模型写 Markdown 又稳又自然，学生也能在「源码」里看懂自己写了什么；
// 换成 JSON 只会让模型更容易写错、学生更看不懂。
//
// 支持的子集（超出子集的行按普通段落处理，不报错、不丢内容）：
//   # ~ ####     标题
//   - / * / +    无序列表       1. 2. 3.  有序列表
//   | a | b |   表格（第二行是 --- 分隔行）
//   **粗体**     行内加粗         空行            分段
import { createZip, xmlEscape, xmlSafe } from './zip.js';

const FONT_EA = 'Microsoft YaHei';
const FONT_LATIN = 'Calibri';
const A4 = { w: 11906, h: 16838, margin: 1418 };

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
  + '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
  + '</Relationships>';

const DOC_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
  + '</Relationships>';

function font(size, bold = false, color = null) {
  return `<w:rPr>${bold ? '<w:b/><w:bCs/>' : ''}`
    + `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`
    + (color ? `<w:color w:val="${color}"/>` : '')
    + `<w:rFonts w:ascii="${FONT_LATIN}" w:hAnsi="${FONT_LATIN}" w:eastAsia="${FONT_EA}" w:cs="${FONT_LATIN}"/></w:rPr>`;
}

/** 行内：**粗体** 拆成多个 run */
function runs(text, { size = 21, color = null } = {}) {
  const parts = String(text || '').split(/(\*\*[^*]+\*\*)/g).filter((piece) => piece !== '');
  if (!parts.length) return `<w:r>${font(size, false, color)}<w:t xml:space="preserve"></w:t></w:r>`;
  return parts.map((piece) => {
    const bold = piece.startsWith('**') && piece.endsWith('**') && piece.length > 4;
    const content = bold ? piece.slice(2, -2) : piece;
    return `<w:r>${font(size, bold, color)}<w:t xml:space="preserve">${xmlEscape(xmlSafe(content))}</w:t></w:r>`;
  }).join('');
}

function paragraph(content, { style = null, size = 21, align = null, numId = null, color = null, spaceAfter = 120 } = {}) {
  // w:pPr 的子元素顺序也是 schema 规定的：pStyle → numPr → … → spacing → ind → jc → … → rPr。
  // 顺序写反时 Word 多半也能开，但别的实现（WPS/在线预览/严格校验器）可能直接判损坏，所以按序拼。
  const pPr = '<w:pPr>'
    + (style ? `<w:pStyle w:val="${style}"/>` : '')
    + (numId ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` : '')
    + `<w:spacing w:after="${spaceAfter}" w:line="300" w:lineRule="auto"/>`
    + (align ? `<w:jc w:val="${align}"/>` : '')
    + '</w:pPr>';
  return `<w:p>${pPr}${content}</w:p>`;
}

function cell(text, { header = false, width = 0 } = {}) {
  return '<w:tc><w:tcPr>'
    + `<w:tcW w:w="${width}" w:type="${width ? 'dxa' : 'auto'}"/>`
    + (header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F4F8"/>' : '')
    + '<w:vAlign w:val="center"/></w:tcPr>'
    + paragraph(runs(text, { size: 20 }), { size: 20, spaceAfter: 60 })
    + '</w:tc>';
}

function table(rows, columns) {
  const width = Math.floor((A4.w - A4.margin * 2) / columns);
  const borders = '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFC7D6"/>`).join('')
    + '</w:tblBorders>';
  const body = rows.map((row, index) => '<w:tr>'
    + (index === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : '')
    + row.map((value) => cell(value, { header: index === 0, width })).join('')
    + '</w:tr>').join('');
  return '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>' + borders
    + '<w:tblLayout w:type="fixed"/></w:tblPr>'
    + `<w:tblGrid>${Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`
    + body + '</w:tbl>'
    // 表格后面必须跟一个段落，否则两个相邻表格/表格结尾会被 Word 视为结构错误
    + paragraph('<w:r><w:t xml:space="preserve"></w:t></w:r>', { spaceAfter: 0 });
}

const HEADING_STYLE = ['Heading1', 'Heading2', 'Heading3', 'Heading4'];
const HEADING_SIZE = [36, 30, 26, 24];

function parseMarkdown(markdown) {
  const lines = String(markdown || '').replaceAll('\r\n', '\n').split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) { index += 1; continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { index += 1; continue; }   // 分隔线：忽略而不是当正文

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(paragraph(runs(heading[2], { size: HEADING_SIZE[level - 1] }), {
        style: HEADING_STYLE[level - 1], size: HEADING_SIZE[level - 1], spaceAfter: 160,
      }));
      index += 1; continue;
    }

    const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push(paragraph(runs(bullet[1]), { numId: 1 }));
      index += 1; continue;
    }
    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ordered) {
      blocks.push(paragraph(runs(ordered[1]), { numId: 2 }));
      index += 1; continue;
    }

    // 表格：连续以 | 开头的行；第二行是 --- 分隔行时才算表格，否则当普通段落（避免误吃正文里的竖线）
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const collected = [];
      let cursor = index;
      while (cursor < lines.length) {
        const candidate = lines[cursor].trim();
        if (!candidate.startsWith('|') || !candidate.endsWith('|')) break;
        collected.push(candidate); cursor += 1;
      }
      const isTable = collected.length >= 2 && /^\|[\s:|-]+\|$/.test(collected[1]);
      if (isTable) {
        const split = (row) => row.slice(1, -1).split('|').map((value) => value.trim());
        const rows = [split(collected[0]), ...collected.slice(2).map(split)];
        const columns = Math.max(...rows.map((row) => row.length));
        const normalized = rows.map((row) => [...row, ...Array(columns - row.length).fill('')]);
        blocks.push(table(normalized, columns));
        index = cursor; continue;
      }
    }

    // 普通段落：把连续的正文行并成一段
    const paragraphLines = [];
    let cursor = index;
    while (cursor < lines.length) {
      const candidate = lines[cursor].trim();
      if (!candidate || /^#{1,4}\s/.test(candidate) || /^[-*+]\s/.test(candidate) || /^\d+[.)]\s/.test(candidate)) break;
      if (candidate.startsWith('|') && candidate.endsWith('|')) break;
      paragraphLines.push(candidate); cursor += 1;
    }
    if (paragraphLines.length) {
      blocks.push(paragraph(runs(paragraphLines.join(' '))));
      index = cursor;
    } else index += 1;
  }
  return blocks;
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:docDefaults><w:rPrDefault><w:rPr>'
  + `<w:rFonts w:ascii="${FONT_LATIN}" w:hAnsi="${FONT_LATIN}" w:eastAsia="${FONT_EA}" w:cs="${FONT_LATIN}"/>`
  + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + HEADING_STYLE.map((styleId, index) => {
    const size = HEADING_SIZE[index];
    return `<w:style w:type="paragraph" w:styleId="${styleId}"><w:name w:val="heading ${index + 1}"/>`
      + '<w:basedOn w:val="Normal"/><w:qFormat/>'
      + `<w:pPr><w:keepNext/><w:outlineLvl w:val="${index}"/><w:spacing w:before="${index ? 200 : 0}" w:after="160"/></w:pPr>`
      + `<w:rPr><w:b/><w:color w:val="${index === 0 ? '1A1A1A' : '2B2B2B'}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  }).join('')
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>'
  + '<w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:hanging="360"/><w:spacing w:after="80"/></w:pPr></w:style>'
  + '</w:styles>';

const NUMBERING = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>'
  + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>'
  + `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>`
  + `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>`
  + '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>'
  + '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>'
  + `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
  + '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
  + '</w:numbering>';

function coreProps(title, author, createdAt) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
    + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${xmlEscape(xmlSafe(title))}</dc:title>`
    + `<dc:creator>${xmlEscape(xmlSafe(author))}</dc:creator>`
    + `<cp:lastModifiedBy>${xmlEscape(xmlSafe(author))}</cp:lastModifiedBy>`
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified>`
    + '</cp:coreProperties>';
}

/**
 * @param {string} markdown 正文（Markdown 子集）
 * @param {{title?: string, author?: string, createdAt?: string}} meta
 */
export function renderDocx(markdown, meta = {}) {
  const blocks = parseMarkdown(markdown);
  const body = blocks.length ? blocks.join('') : paragraph('<w:r><w:t xml:space="preserve"></w:t></w:r>');
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<w:body>${body}`
    + `<w:sectPr><w:pgSz w:w="${A4.w}" w:h="${A4.h}"/>`
    + `<w:pgMar w:top="${A4.margin}" w:right="${A4.margin}" w:bottom="${A4.margin}" w:left="${A4.margin}" `
    + 'w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'
    + '</w:body></w:document>';
  const createdAt = String(meta.createdAt || new Date().toISOString()).replace(/\.\d+Z$/, 'Z');
  const buffer = createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
    { name: 'docProps/core.xml', data: coreProps(meta.title || '文档', meta.author || 'AI 魔法学院', createdAt) },
    { name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
      + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
      + '<Application>AI 魔法学院</Application><AppVersion>1.0</AppVersion></Properties>' },
  ]);
  return { buffer, blockCount: blocks.length };
}
