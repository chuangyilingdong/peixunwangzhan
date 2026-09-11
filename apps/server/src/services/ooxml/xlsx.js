// XLSX 渲染：把 **CSV** 渲染成真正的 .xlsx 字节。
//
// 为什么用 CSV 而不是 JSON：模型写 CSV 几乎不会错，而且 CSV 本身就是「表格」最自然的文本形态，
// 学生在「源码」里看到的也是一张一眼能读的表，而不是一堆括号。
//
// 做法：字符串走 inlineStr（免掉 sharedStrings 这一整个部件及其索引规则），
// 数字/布尔/公式按类型落格，首行加粗并冻结，列宽按内容估算。
import { createZip, xmlEscape, xmlSafe } from './zip.js';

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

// 两个单元格格式：0 = 普通、1 = 加粗（首行表头）
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="2">'
  + '<font><sz val="11"/><name val="Microsoft YaHei"/></font>'
  + '<font><b/><sz val="11"/><name val="Microsoft YaHei"/></font>'
  + '</fonts>'
  + '<fills count="3"><fill><patternFill patternType="none"/></fill>'
  + '<fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F8"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="2"><border/>'
  + '<border><left style="thin"><color rgb="FFBFC7D6"/></left><right style="thin"><color rgb="FFBFC7D6"/></right>'
  + '<top style="thin"><color rgb="FFBFC7D6"/></top><bottom style="thin"><color rgb="FFBFC7D6"/></bottom></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="3">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>'
  + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>'
  + '</cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  + '</styleSheet>';

/** CSV 解析：支持双引号包裹、字段内逗号/换行/转义双引号 */
export function parseCsv(text) {
  const source = String(text ?? '').replaceAll('\r\n', '\n');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  // 去掉全空的行（模型常在末尾多留一行）
  return rows.filter((line) => line.some((value) => String(value).trim() !== ''));
}

function columnName(index) {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/** 单元格取值：数字/布尔落原生类型，其余当字符串（含公式以外的一切） */
function cellXml(value, ref, styleIndex) {
  const raw = String(value ?? '');
  const trimmed = raw.trim();
  if (trimmed === '') return `<c r="${ref}" s="${styleIndex}"/>`;
  if (/^-?\d+(\.\d+)?$/.test(trimmed) && trimmed.length <= 15) {
    return `<c r="${ref}" s="${styleIndex}"><v>${trimmed}</v></c>`;
  }
  if (trimmed.toUpperCase() === 'TRUE' || trimmed.toUpperCase() === 'FALSE') {
    return `<c r="${ref}" s="${styleIndex}" t="b"><v>${trimmed.toUpperCase() === 'TRUE' ? 1 : 0}</v></c>`;
  }
  return `<c r="${ref}" s="${styleIndex}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(xmlSafe(raw))}</t></is></c>`;
}

/**
 * @param {string} csv
 * @param {{sheetName?: string}} options
 */
export function renderXlsx(csv, options = {}) {
  const rows = parseCsv(csv);
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const sheetName = String(options.sheetName || '工作表').slice(0, 30) || '工作表';

  // 列宽按最长内容估算（中文按两个字宽），限制在合理区间
  const widths = [];
  for (let column = 0; column < columnCount; column += 1) {
    let longest = 6;
    for (const row of rows) {
      const text = String(row[column] ?? '');
      const visual = [...text].reduce((sum, char) => sum + (/[\u4e00-\u9fff\uff00-\uffef]/.test(char) ? 2 : 1), 0);
      longest = Math.max(longest, visual);
    }
    widths.push(Math.min(48, Math.max(8, longest + 2)));
  }

  const sheetData = rows.map((row, rowIndex) => {
    const cells = [];
    for (let column = 0; column < row.length; column += 1) {
      cells.push(cellXml(row[column], `${columnName(column)}${rowIndex + 1}`, rowIndex === 0 ? 1 : 2));
    }
    return `<row r="${rowIndex + 1}">${cells.join('')}</row>`;
  }).join('');

  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<dimension ref="A1:${columnName(columnCount - 1)}${Math.max(1, rows.length)}"/>`
    + '<sheetViews><sheetView workbookViewId="0">'
    // 冻结首行（表头），学生往下滚的时候还知道每列是什么
    + (rows.length > 1 ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : '')
    + '<selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="16"/>'
    + `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${sheetData}</sheetData>`
    + `<autoFilter ref="A1:${columnName(columnCount - 1)}${Math.max(1, rows.length)}"/>`
    + '</worksheet>';

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${xmlEscape(xmlSafe(sheetName))}" sheetId="1" r:id="rId1"/></sheets>`
    + '</workbook>';

  const buffer = createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
  return { buffer, rowCount: rows.length, columnCount };
}
