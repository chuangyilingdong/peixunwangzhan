// 文档产物的**独立实现读回**守卫。
//
// p45 验的是「包合不合规」（自己的规则、自己的代码），这一条验的是**另一个实现读不读得懂**：
// python-pptx / python-docx / openpyxl 是三个完全独立的库，它们能解析出正确的文字/单元格，
// 才说明 Office / WPS 也大概率能打开。两条守卫互补，缺一不可：
//   · 只跑 p45 → 可能「我们自己觉得合规、实际没人读得懂」
//   · 只跑 p46 → 出了错也说不清是哪一层坏的
//
// 依赖：本机有 python3（含 python-pptx / python-docx / openpyxl）。缺依赖时**显式失败**，
// 不静默跳过 —— 静默跳过的守卫等于没有守卫（这个项目已经吃过三次「界面不报错、日志不报错」的亏）。
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderPptx } from '../apps/server/src/services/ooxml/pptx.js';
import { renderDocx } from '../apps/server/src/services/ooxml/docx.js';
import { renderXlsx } from '../apps/server/src/services/ooxml/xlsx.js';

const PYTHON_CANDIDATES = [
  process.env.PYTHON,
  'C:/Users/Administrator/AppData/Local/Programs/Python/Python311/python.exe',
  'python3', 'python',
].filter(Boolean);

function pickPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      execFileSync(candidate, ['-c', 'import pptx, docx, openpyxl'], { stdio: 'pipe' });
      return candidate;
    } catch { /* 换下一个 */ }
  }
  return null;
}

const python = pickPython();
assert.ok(python, [
  'P46 需要 python + python-pptx + python-docx + openpyxl 才能做独立读回。',
  '装法：python -m pip install python-pptx python-docx openpyxl',
  '（这条守卫故意不静默跳过：跳过就等于没有它。）',
].join('\n'));

const DECK = {
  title: '去新疆旅游',
  subtitle: '从乌鲁木齐到喀什的 8 天',
  author: '五年三班 小明',
  slides: [
    { title: '为什么去新疆', bullets: ['中国面积最大的省级行政区', '三月看杏花'] },
    { title: '要带什么', bullets: ['防晒霜、墨镜、帽子', '早晚温差大，带外套'] },
  ],
};
const MARKDOWN = '# 我的暑假计划\n\n这个暑假我想学会 **游泳**。\n\n## 时间安排\n\n- 七月上午：游泳课\n- 七月下午：写作业\n\n| 项目 | 金额 |\n| --- | --- |\n| 游泳课 | 1200 |\n';
const CSV = '日期,项目,金额\n2026-07-01,游泳课,1200\n2026-08-02,去新疆,3500\n';

const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-kids-p46-'));
const deckPath = path.join(dir, 'deck.pptx');
const docPath = path.join(dir, 'plan.docx');
const sheetPath = path.join(dir, 'cost.xlsx');
const imageDeckPath = path.join(dir, 'with-image.pptx');
writeFileSync(deckPath, renderPptx(DECK).buffer);
writeFileSync(docPath, renderDocx(MARKDOWN, { title: '我的暑假计划' }).buffer);
writeFileSync(sheetPath, renderXlsx(CSV, { sheetName: '暑假花销' }).buffer);

// 带图的那一份：用一张真的 1×1 PNG（非法图片会被渲染器按「这一页不放图」处理，测不出内嵌）
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const DECK_WITH_IMAGE = {
  title: '我的旅行',
  slides: [
    { title: '赛里木湖', bullets: ['湖水蓝得像宝石'], imageAttachment: 1 },
    { title: '只有图的一页', bullets: [], imageAttachment: 2 },
  ],
};
writeFileSync(imageDeckPath, renderPptx(DECK_WITH_IMAGE, new Map([[1, PIXEL_PNG], [2, PIXEL_PNG]])).buffer);

const script = `
import json, sys, hashlib
from pptx import Presentation
from docx import Document
import openpyxl

def read_deck(path):
    deck = Presentation(path)
    slides = []
    for slide in deck.slides:
        texts = [sh.text_frame.text for sh in slide.shapes if sh.has_text_frame and sh.text_frame.text.strip()]
        pictures = []
        for sh in slide.shapes:
            if sh.shape_type == 13 or getattr(sh, 'image', None) is not None:
                try:
                    pictures.append(hashlib.sha256(sh.image.blob).hexdigest()[:16])
                except Exception:
                    pictures.append('unreadable')
        slides.append({'texts': texts, 'pictures': pictures})
    return {'slideCount': len(deck.slides), 'slideWidth': deck.slide_width, 'slides': slides}

doc = Document(sys.argv[2])
wb = openpyxl.load_workbook(sys.argv[3])
sheet = wb.active
print(json.dumps({
    'deck': read_deck(sys.argv[1]),
    'imageDeck': read_deck(sys.argv[4]),
    'paragraphs': [(p.style.name, p.text) for p in doc.paragraphs if p.text.strip()],
    'tables': [[cell.text for cell in row.cells] for row in doc.tables[0].rows] if doc.tables else [],
    'sheetName': sheet.title,
    'freeze': str(sheet.freeze_panes),
    'headerBold': bool(sheet['A1'].font.bold),
    'cells': [[c for c in row] for row in sheet.iter_rows(values_only=True)],
}, ensure_ascii=False))
`;

const output = execFileSync(python, ['-c', script, deckPath, docPath, sheetPath, imageDeckPath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
const result = JSON.parse(output);

const result0 = result.deck;
assert.equal(result0.slideCount, DECK.slides.length + 1, `python-pptx 读出的页数不对：${result0.slideCount}`);
assert.equal(result0.slideWidth, 12192000, 'python-pptx 读出的画布宽度不对（16:9 应为 12192000）');
const allSlideText = result0.slides.flatMap((slide) => slide.texts).join('\n');
for (const expected of ['去新疆旅游', '从乌鲁木齐到喀什的 8 天', '为什么去新疆', '中国面积最大的省级行政区', '要带什么', '防晒霜、墨镜、帽子']) {
  assert.ok(allSlideText.includes(expected), `python-pptx 没读出「${expected}」`);
}

// 配图必须是**真的内嵌进了 pptx**，而不是只写了个关系
const expectedHash = createHash('sha256').update(PIXEL_PNG).digest('hex').slice(0, 16);
assert.equal(result.imageDeck.slideCount, DECK_WITH_IMAGE.slides.length + 1, '带图 deck 的页数不对');
assert.deepEqual(result.imageDeck.slides[1].pictures, [expectedHash], `第 1 页的内嵌图与原图不一致：${JSON.stringify(result.imageDeck.slides[1].pictures)}`);
assert.deepEqual(result.imageDeck.slides[2].pictures, [expectedHash], '第 2 页（只有图）的内嵌图不一致');
assert.ok(result.imageDeck.slides[2].texts.join('').includes('只有图的一页'), '第 2 页的标题丢了');
assert.deepEqual(result0.slides[1].pictures, [], '不带图的 deck 里不该有图片');

const paragraphText = result.paragraphs.map(([, text]) => text).join('\n');
for (const expected of ['我的暑假计划', '这个暑假我想学会 游泳。', '时间安排', '七月上午：游泳课']) {
  assert.ok(paragraphText.includes(expected), `python-docx 没读出「${expected}」（标题样式：${JSON.stringify(result.paragraphs.map(([style]) => style))}）`);
}
assert.ok(result.paragraphs.some(([style]) => style.startsWith('Heading')), 'python-docx 没识别出任何标题样式');
assert.deepEqual(result.tables[0], ['项目', '金额'], `python-docx 读出的表格首行不对：${JSON.stringify(result.tables[0])}`);

assert.equal(result.sheetName, '暑假花销', 'openpyxl 读出的工作表名不对');
assert.equal(result.freeze, 'A2', 'openpyxl 读出的冻结窗格不对（应为冻结首行 A2）');
assert.equal(result.headerBold, true, 'openpyxl 读出头行不是加粗的');
assert.deepEqual(result.cells[0], ['日期', '项目', '金额'], 'openpyxl 读出的表头不对');
assert.deepEqual(result.cells[1], ['2026-07-01', '游泳课', 1200], 'openpyxl 读出的数据行不对');
assert.equal(typeof result.cells[2][2], 'number', 'openpyxl 读出的金额不是数字（落成了文本）');

rmSync(dir, { recursive: true, force: true });
console.log(`P46 office documents independent-reader guard passed（${path.basename(python)}：pptx ${result0.slideCount} 页（含 2 张内嵌图）/ docx ${result.paragraphs.length} 段 / xlsx ${result.cells.length} 行）`);
