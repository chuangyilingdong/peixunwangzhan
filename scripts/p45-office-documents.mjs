// 文档产物（pptx / docx / xlsx）的结构守卫 —— **纯 Node，不依赖 python 或任何第三方包**。
//
// 为什么需要它：Office 文件坏掉时的表现是「生成成功、下载成功、双击打不开」，
// 日志里一个字都没有 —— 典型的静默失败。而且这类错误在**另一个实现**里才会现形
// （Word 能开、WPS 打不开；PowerPoint 提示修复、在线预览直接白屏）。
// 所以这里不验“我们生成得对不对”，而是验**包本身合不合规**：
//   · ZIP：中央目录、CRC、条目数与偏移一致，名字带 UTF-8 标志位
//   · XML：良构（自带一个极小的检查器，不引依赖）
//   · OOXML：`[Content_Types].xml` 必须存在且是第一个条目、每个部件都被声明覆盖、
//            每条关系（rels）都能解析到真实存在的部件
// 独立实现层面的读回验证在 p46（需要 python-pptx / openpyxl / python-docx）。
import { strict as assert } from 'node:assert';
import { inflateRawSync } from 'node:zlib';
import { COVER_IMAGE_KEY, renderPptx } from '../apps/server/src/services/ooxml/pptx.js';
import { renderDocx } from '../apps/server/src/services/ooxml/docx.js';
import { renderXlsx } from '../apps/server/src/services/ooxml/xlsx.js';
import { renderDocument, parseDeckSpec, deckIllustrationRequests } from '../apps/server/src/services/ooxml/documents.js';

/* ── 极小的 ZIP 读取器（与写入器是两套代码，能互相印证） ── */
function readZip(buffer) {
  const eocdIndex = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocdIndex >= 0, 'ZIP：找不到 EOCD 结束记录');
  const total = buffer.readUInt16LE(eocdIndex + 10);
  const centralSize = buffer.readUInt32LE(eocdIndex + 12);
  const centralOffset = buffer.readUInt32LE(eocdIndex + 16);
  assert.equal(centralOffset + centralSize, eocdIndex, 'ZIP：中央目录大小/偏移与 EOCD 不自洽');

  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < total; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `ZIP：第 ${index + 1} 个中央目录条目签名不对`);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.equal(flags & 0x0800, 0x0800, `ZIP：${name} 没有置 UTF-8 名字标志位`);

    // 顺着本地头把内容取出来（偏移来自中央目录，两边不一致就是坏包）
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `ZIP：${name} 的本地头偏移指向了错误位置`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    assert.equal(data.length, uncompressedSize, `ZIP：${name} 解压后长度与声明不符`);
    assert.equal(crc32(data), crc, `ZIP：${name} 的 CRC 不匹配`);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// 与写入器独立的一份 crc32（用查表法自己算，不复用 node:zlib 的实现）
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ── 极小的 XML 良构检查器：够抓住「少个 > 」「标签没闭合」这类会让人打不开文件的错 ── */
function assertWellFormed(xml, label) {
  const text = String(xml);
  assert.ok(text.startsWith('<?xml '), `${label}：缺少 XML 声明`);
  const stack = [];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open < 0) break;
    if (text.startsWith('<!--', open)) { const end = text.indexOf('-->', open); assert.ok(end > 0, `${label}：注释没有闭合`); index = end + 3; continue; }
    if (text.startsWith('<![CDATA[', open)) { const end = text.indexOf(']]>', open); assert.ok(end > 0, `${label}：CDATA 没有闭合`); index = end + 3; continue; }
    // 属性值里允许出现 >，所以扫到真正的标签结束符为止
    let cursor = open + 1;
    let quote = null;
    while (cursor < text.length) {
      const char = text[cursor];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      cursor += 1;
    }
    assert.ok(cursor < text.length, `${label}：有标签没有闭合的 >（偏移 ${open} 附近：${text.slice(open, open + 60)}）`);
    const tag = text.slice(open, cursor + 1);
    index = cursor + 1;
    if (tag.startsWith('<?') || tag.startsWith('<!')) continue;
    const selfClosing = tag.endsWith('/>');
    const closing = tag.startsWith('</');
    const name = (closing ? tag.slice(2) : tag.slice(1)).split(/[\s/>]/)[0];
    if (closing) {
      const top = stack.pop();
      assert.equal(top, name, `${label}：闭合标签 </${name}> 与最近的 <${top}> 不匹配`);
    } else if (!selfClosing) stack.push(name);
  }
  assert.equal(stack.length, 0, `${label}：还有没闭合的标签 ${stack.join(', ')}`);
}

/* ── OOXML 包级不变量 ── */
function assertOoxmlPackage(buffer, { label, requiredParts = [] }) {
  const entries = readZip(buffer);
  const names = [...entries.keys()];
  assert.ok(names.length, `${label}：包是空的`);
  assert.equal(names[0], '[Content_Types].xml', `${label}：第一个条目必须是 [Content_Types].xml，实际是 ${names[0]}`);

  for (const name of names) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) assertWellFormed(entries.get(name).toString('utf8'), `${label}:${name}`);
  }

  const contentTypes = entries.get('[Content_Types].xml').toString('utf8');
  const defaults = new Set([...contentTypes.matchAll(/<Default Extension="([^"]+)"/g)].map((match) => match[1].toLowerCase()));
  const overrides = new Set([...contentTypes.matchAll(/<Override PartName="([^"]+)"/g)].map((match) => match[1]));

  for (const name of names) {
    if (name === '[Content_Types].xml') continue;
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    // 每个部件要么被显式 Override，要么其扩展名有 Default；否则 OPC 阅读器会拒绝整包
    assert.ok(defaults.has(extension) || overrides.has('/' + name), `${label}：${name} 没有被 [Content_Types].xml 覆盖`);
  }
  for (const part of overrides) {
    assert.ok(entries.has(part.slice(1)), `${label}：Content_Types 声明的部件 ${part} 在包里不存在`);
  }
  for (const name of requiredParts) assert.ok(entries.has(name), `${label}：缺少必需的部件 ${name}`);

  // 关系表里的目标必须能解析到真实部件（相对路径按所在目录解析）
  for (const name of names.filter((item) => item.endsWith('.rels'))) {
    const baseDir = name === '_rels/.rels' ? '' : name.replace(/_rels\/[^/]+$/, '');
    const text = entries.get(name).toString('utf8');
    for (const match of text.matchAll(/Target="([^"]+)"(?![^>]*TargetMode="External")/g)) {
      const target = match[1];
      if (/^https?:/i.test(target)) continue;
      const resolved = new URL(target, `http://x/${baseDir}`).pathname.slice(1);
      assert.ok(entries.has(resolved), `${label}：${name} 里的关系目标 ${target}（解析为 ${resolved}）不存在`);
    }
  }
  return entries;
}

// 画布尺寸（与 pptx.js 一致：16:9）
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;

/* ── 三份样例 ── */
const DECK = {
  title: '去新疆旅游',
  subtitle: '从乌鲁木齐到喀什的 8 天',
  author: '五年三班 小明',
  slides: [
    { title: '为什么去新疆', bullets: ['中国面积最大的省级行政区', '三月看杏花，九月看胡杨', '雪山、草原、沙漠一次走完'] },
    { title: '行程安排', bullets: ['D1–D2 乌鲁木齐', 'D3–D4 赛里木湖', 'D5–D8 喀什老城'] },
    { title: '要带什么', bullets: ['防晒霜、墨镜、帽子', '早晚温差大，带外套'] },
  ],
};
const MARKDOWN = '# 我的暑假计划\n\n这个暑假我想学会 **游泳**。\n\n## 时间安排\n\n- 七月上午：游泳课\n- 七月下午：写作业\n\n1. 先学换气\n2. 再练自由泳\n\n## 预算\n\n| 项目 | 金额 |\n| --- | --- |\n| 游泳课 | 1200 |\n| 交通 | 800 |\n';
const CSV = '日期,项目,金额,备注\n2026-07-01,游泳课,1200,十次\n2026-08-02,去新疆,3500,"含机票,住宿"\n合计,,4789,\n';

const pptx = renderPptx(DECK).buffer;
const docx = renderDocx(MARKDOWN, { title: '我的暑假计划' }).buffer;
const xlsx = renderXlsx(CSV, { sheetName: '暑假花销' }).buffer;

const pptxEntries = assertOoxmlPackage(pptx, {
  label: 'pptx',
  requiredParts: ['_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'ppt/slides/slide1.xml', 'ppt/slides/_rels/slide1.xml.rels', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml'],
});
assertOoxmlPackage(docx, { label: 'docx', requiredParts: ['_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml'] });
assertOoxmlPackage(xlsx, { label: 'xlsx', requiredParts: ['_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/styles.xml'] });

// 页数要对得上（封面 + 内容页），且每页都被 presentation.xml 引用
const presentation = pptxEntries.get('ppt/presentation.xml').toString('utf8');
const slideRefs = [...presentation.matchAll(/<p:sldId [^>]*r:id="(rId\d+)"/g)].map((match) => match[1]);
assert.equal(slideRefs.length, DECK.slides.length + 1, 'pptx：presentation.xml 里的页数与「封面 + 内容页」不一致');
const presentationRels = pptxEntries.get('ppt/_rels/presentation.xml.rels').toString('utf8');
for (const ref of slideRefs) assert.ok(presentationRels.includes(`Id="${ref}"`), `pptx：presentation.xml 引用了不存在的关系 ${ref}`);
const slideParts = [...pptxEntries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
assert.equal(slideParts.length, DECK.slides.length + 1, 'pptx：包里的 slide 部件数量不对');

// 三份文档里都要能找到内容（防止「包合法但正文是空的」）
assert.ok(pptxEntries.get('ppt/slides/slide2.xml').toString('utf8').includes('为什么去新疆'), 'pptx：第二页标题没进正文');
const docxEntries = readZip(docx);
assert.ok(docxEntries.get('word/document.xml').toString('utf8').includes('我的暑假计划'), 'docx：标题没进正文');
const xlsxEntries = readZip(xlsx);
const sheet = xlsxEntries.get('xl/worksheets/sheet1.xml').toString('utf8');
assert.ok(sheet.includes('游泳课') && sheet.includes('含机票,住宿'), 'xlsx：单元格内容没进表');

// 渲染入口（download 走的就是它）
for (const [kind, content, name] of [['pptx', JSON.stringify(DECK), '去新疆旅游.pptx'], ['docx', MARKDOWN, '计划.docx'], ['xlsx', CSV, '花销.xlsx']]) {
  const rendered = renderDocument({ kind, content, name });
  assert.ok(rendered.buffer && rendered.buffer.length > 0, `${kind}：renderDocument 没返回字节`);
  assert.ok(rendered.mime.includes('openxmlformats'), `${kind}：MIME 不对（${rendered.mime}）`);
}

/* ── 配图：{"attachment": N} 指的是「这一轮学生传的第 N 张图」 ── */
{
  const withImage = {
    title: '我的旅行',
    slides: [
      { title: '封面页', bullets: ['配一张图'], imageAttachment: 1 },
      { title: '只有图的一页', bullets: [], imageAttachment: 2 },
      { title: '不存在的图', bullets: ['第 3 张没传'], imageAttachment: 3 },
    ],
  };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const rendered = renderDocument({ kind: 'pptx', content: JSON.stringify(withImage), name: '带图.pptx' }, {
    attachmentImages: new Map([[1, png], [2, png]]),
  });
  assert.ok(!rendered.error, `带图的 PPT 渲染失败：${rendered.error}`);
  const entries = assertOoxmlPackage(rendered.buffer, { label: 'pptx-with-image' });
  const media = [...entries.keys()].filter((name) => name.startsWith('ppt/media/'));
  assert.equal(media.length, 2, `带图的 PPT 里图片部件数不对：${JSON.stringify(media)}`);
  for (const name of media) assert.ok(entries.get(name).equals(png), `${name} 的字节与原图不一致`);
  // png 必须在 [Content_Types].xml 里有 Default 声明，否则 PowerPoint 直接说文件损坏
  const contentTypes = entries.get('[Content_Types].xml').toString('utf8');
  assert.ok(/<Default Extension="png"/.test(contentTypes), '配图后 Content_Types 里没有 png 的默认声明');
  // 有图的那两页要有 <p:pic> 与图片关系；引用不存在的第 3 张时**只是那页不放图**，不整份失败
  assert.ok(entries.get('ppt/slides/slide2.xml').toString('utf8').includes('<p:pic>'), '第 1 页没有图片形状');
  assert.ok(entries.get('ppt/slides/slide3.xml').toString('utf8').includes('<p:pic>'), '第 2 页（只有图）没有图片形状');
  assert.ok(!entries.get('ppt/slides/slide4.xml').toString('utf8').includes('<p:pic>'), '第 3 页引用了不存在的图，不该有图片形状');
  assert.ok(entries.get('ppt/slides/_rels/slide2.xml.rels').toString('utf8').includes('image'), '第 1 页缺少图片关系');
  assert.ok(!entries.get('ppt/slides/_rels/slide4.xml.rels').toString('utf8').includes('image'), '第 3 页不该有图片关系');
  // 平台**生成**的插画：按幻灯片下标给图，优先于学生传的图
  {
    const deck = {
      title: '带插画的 PPT',
      slides: [
        { title: '第一页', bullets: ['要有插画'], imagePrompt: '雪山与湖泊，写实插画' },
        { title: '第二页', bullets: ['没有插画'] },
      ],
    };
    const spec = parseDeckSpec(JSON.stringify(deck));
    assert.equal(spec.slides[0].imagePrompt, '雪山与湖泊，写实插画', 'imagePrompt 解析丢了');
    assert.equal(deckIllustrationRequests(spec).length, 1, '只该识别出 1 个生成请求');
    assert.deepEqual(deckIllustrationRequests(spec)[0], { slideIndex: 0, prompt: '雪山与湖泊，写实插画' });
    const rendered = renderDocument({ kind: 'pptx', content: JSON.stringify(deck), name: '插画.pptx' }, { generatedImages: new Map([[0, png]]) });
    assert.ok(!rendered.error, '带生成插画的 PPT 渲染失败：' + rendered.error);
    const entries = assertOoxmlPackage(rendered.buffer, { label: 'pptx-generated-image' });
    assert.equal([...entries.keys()].filter((n) => n.startsWith('ppt/media/')).length, 1, '生成插画没进包');
    assert.ok(entries.get('ppt/slides/slide2.xml').toString('utf8').includes('<p:pic>'), '第 1 页没有插画');
    assert.ok(!entries.get('ppt/slides/slide3.xml').toString('utf8').includes('<p:pic>'), '第 2 页没要求插画，不该有图');
    // 生成失败（比如渠道挂了）：那一页不放图，但整份仍然能下载
    const failed = renderDocument({ kind: 'pptx', content: JSON.stringify(deck), name: '插画.pptx' }, { generatedImages: new Map() });
    assert.ok(!failed.error && failed.buffer.length > 0, '生成失败时也该能出文件（只是没有图）');
  }

  // 序列化回 JSON 的结构要能读回来（供 p46 复用同一份规格）
  assert.equal(parseDeckSpec(JSON.stringify(withImage)).slides[0].imageAttachment, 1, 'imageAttachment 解析丢了');
}

/* ── 版式与几何：看不到 pptx，就把「会不会出画布 / 版式有没有生效」变成断言 ── */
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const deck = {
    title: '大美新疆', subtitle: '旅游全攻略', author: '五年三班', theme: 'ocean',
    cover: { prompt: '雪山湖泊全景' },
    slides: [
      { title: '出行概览', bullets: ['最佳时间 6–9 月', '南北疆怎么安排', '带什么'], imagePrompt: '雪山' },
      { layout: 'section', title: '必去景点' },
      { title: '喀纳斯', bullets: ['湖怪传说', '十月金黄'] },
      { title: '整页图', bullets: [], imagePrompt: '秋色' },
      { layout: 'quote', title: '不到新疆，不知中国之大。' },
      { layout: 'thanks' },
    ],
  };
  const rendered = renderDocument(
    { kind: 'pptx', content: JSON.stringify(deck), name: '大美新疆.pptx' },
    { generatedImages: new Map([[COVER_IMAGE_KEY, png], [0, png], [3, png]]) },
  );
  assert.ok(!rendered.error, `带版式的 PPT 渲染失败：${rendered.error}`);
  const entries = assertOoxmlPackage(rendered.buffer, { label: 'pptx-layouts' });

  // 每页的形状都要落在画布内：出画布的表现是「内容被裁掉」，而文件本身照样有效
  const slideNames = [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort();
  assert.equal(slideNames.length, 7, `封面 + 6 页应当有 7 个 slide 部件，实际 ${slideNames.length}`);
  let shapes = 0;
  for (const name of slideNames) {
    const xml = entries.get(name).toString('utf8');
    for (const match of xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"/g)) {
      const [x, y, cx, cy] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
      shapes += 1;
      assert.ok(x >= 0 && y >= 0, `${name} 有形状跑到画布左上角之外：x=${x} y=${y}`);
      assert.ok(x + cx <= SLIDE_W + 1 && y + cy <= SLIDE_H + 1, `${name} 有形状溢出画布：x=${x}+${cx}, y=${y}+${cy}`);
    }
  }
  assert.ok(shapes > 25, `只检查到 ${shapes} 个形状，几何断言的匹配规则可能失效了`);

  // 版式真的落地了
  const allText = slideNames.map((name) => entries.get(name).toString('utf8')).join('');
  assert.ok(allText.includes('谢谢观看'), '结尾页没渲染出来');
  assert.ok(allText.includes('不到新疆'), '金句页没渲染出来');
  assert.ok(/<a:alpha val="58000"\/>/.test(allText), '封面蒙层（58% 不透明）没渲染出来 —— 白字压在图上是看不清的');
  // 主题要真的生效：ocean 的强调色在、默认那套橙不在
  assert.ok(allText.includes('1B7FD4'), 'ocean 主题的强调色没进 XML，主题可能没生效');
  assert.ok(!allText.includes('FF6B2C'), '默认主题的橙色还在，说明主题没被用上');
  // 封面用了生成图；带图的正文页有图片关系
  assert.ok(entries.has('ppt/slides/_rels/slide1.xml.rels') && entries.get('ppt/slides/_rels/slide1.xml.rels').toString('utf8').includes('image'), '封面图没建立关系');
}

/* ── 文字自适应：长要点自动降字号，不能溢出正文框 ── */
{
  const long = '这是一条特别长的要点'.repeat(12);
  const squeezed = renderDocument({
    kind: 'pptx',
    content: JSON.stringify({ title: 't', slides: [{ title: '挤一挤', bullets: Array.from({ length: 12 }, (_, i) => `${long}${i}`) }] }),
    name: 'x.pptx',
  });
  assert.ok(!squeezed.error, `长要点渲染失败：${squeezed.error}`);
  // 注意：页面上还有标题（3000），所以不能拿「最大字号」判断正文有没有降档
  const sizes = [...readZip(squeezed.buffer).get('ppt/slides/slide2.xml').toString('utf8').matchAll(/sz="(\d+)"/g)].map((m) => Number(m[1]));
  const bodySizes = sizes.filter((size) => size <= 2000);
  assert.ok(bodySizes.length, '没找到正文字号，断言的匹配规则可能失效了');
  assert.ok(bodySizes.some((size) => size < 1800), `长要点没有触发降字号（正文字号 ${bodySizes.join(',')}）`);
  assert.ok(Math.min(...bodySizes) >= 1000, `字号降到 ${Math.min(...bodySizes)} 就太小了，学生看不清`);

  const shortDoc = renderDocument({
    kind: 'pptx',
    content: JSON.stringify({ title: 't', slides: [{ title: '正常', bullets: ['短要点一', '短要点二'] }] }),
    name: 'y.pptx',
  });
  const shortSizes = [...readZip(shortDoc.buffer).get('ppt/slides/slide2.xml').toString('utf8').matchAll(/sz="(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(shortSizes.some((size) => size === 1800), `短要点不该被降档（字号 ${shortSizes.join(',')}）`);
}

// 坏的规格要**给出可读的错误**，而不是抛栈或产出坏文件
assert.ok(renderDocument({ kind: 'pptx', content: '这不是 JSON', name: 'x.pptx' }).error, 'pptx：坏规格应当返回 error');
assert.equal(parseDeckSpec('```json\n{"slides":[{"title":"一"}]}\n```')?.slides.length, 1, 'pptx：宽容解析应当能吃下带围栏的 JSON');
// 控制字符必须被清掉（否则整份文件打不开，而且看不出原因）
assert.equal(renderDocument({ kind: 'docx', content: '标题\u0000\u0007结尾', name: 'a.docx' }).error, undefined, 'docx：控制字符应当被清掉而不是让渲染失败');

console.log(`P45 office documents structure guard passed（pptx ${pptx.length}B / docx ${docx.length}B / xlsx ${xlsx.length}B）`);
