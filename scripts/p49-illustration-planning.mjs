// 「给 PPT 配插画」这条链路的**规划**部分守卫（纯函数，不起服务、不调上游）。
//
// 真正生成要花钱、要联网，不适合放进每次都能跑的守卫；但「**该生成哪些**」是纯逻辑，
// 而且这里错一点后果都不小：数量失控就是账单失控，把非 pptx 也算进来就是白跑。
// 所以把口径钉住：只认 pptx、只认写了 prompt 的页、每份最多 3 张、露出的提示词要截断。
import { strict as assert } from 'node:assert';
import { parseDeckSpec, deckIllustrationRequests } from '../apps/server/src/services/ooxml/documents.js';
import { collectIllustrationTargets, MAX_ILLUSTRATIONS_PER_DECK } from '../apps/server/src/services/vibecodingIllustrations.js';

const deck = (slides) => JSON.stringify({ title: 't', slides });

// parseDeckSpec 会把规格整理成 slides[]（这一步也是「哪些页要图」的唯一来源）
const spec = parseDeckSpec(deck([
  { title: '封面', bullets: ['大美新疆'], image: { prompt: '雪山湖泊，写实插画，横构图' } },
  { title: '行程', bullets: ['D1 乌鲁木齐'] },
  { title: '美食', bullets: ['大盘鸡'], image: { prompt: '新疆美食拼盘，暖色调' } },
  { title: '学生自己的图', bullets: ['用我传的'], image: { attachment: 1 } },
]));
assert.equal(spec.slides.length, 4, '四页都该保留');

const requests = deckIllustrationRequests(spec);
assert.equal(requests.length, 2, `只该识别出 2 个生成请求，实际 ${requests.length}`);
assert.deepEqual(requests.map((item) => item.slideIndex), [0, 2], '页下标要对上（第 4 页是学生的图，不生成）');
assert.ok(/写实插画/.test(requests[0].prompt), '提示词要原样带出来');

// 每份 deck 最多 3 张 —— 这是账单的闸，不能只靠提示词里那句「最多 3 张」
const many = parseDeckSpec(deck(Array.from({ length: 9 }, (_, i) => ({ title: `第${i + 1}页`, bullets: ['x'], image: { prompt: `画面 ${i + 1}` } }))));
assert.equal(deckIllustrationRequests(many).length, 9, '解析阶段不该自己截断（截断在收集阶段做）');
const targets = collectIllustrationTargets([{ id: 'a1', kind: 'pptx', name: 'x.pptx', content: deck(Array.from({ length: 9 }, (_, i) => ({ title: `第${i + 1}页`, bullets: ['x'], image: { prompt: `画面 ${i + 1}` } }))) }]);
assert.equal(targets.length, 1, '这份 pptx 该被选为目标');
assert.equal(targets[0].requests.length, MAX_ILLUSTRATIONS_PER_DECK, `每份 deck 最多 ${MAX_ILLUSTRATIONS_PER_DECK} 张，实际 ${targets[0].requests.length}`);
assert.equal(MAX_ILLUSTRATIONS_PER_DECK, 3, '3 是产品定的口径，要改先想清楚账单');

// 只认 pptx：word / excel 不生成插画（它们是文档与表格，配图没有意义）
for (const kind of ['docx', 'xlsx', 'html', 'md']) {
  assert.equal(collectIllustrationTargets([{ id: 'a', kind, name: `x.${kind}`, content: deck([{ title: 'a', image: { prompt: 'p' } }]) }]).length, 0, `${kind} 不该被当成配图目标`);
}
// 没写 prompt 的（哪怕写了 attachment）不生成
assert.equal(collectIllustrationTargets([{ id: 'a', kind: 'pptx', name: 'x.pptx', content: deck([{ title: 'a', image: { attachment: 1 } }]) }]).length, 0, '只引用学生图片时不该去生成');
// 坏规格不炸
assert.equal(collectIllustrationTargets([{ id: 'a', kind: 'pptx', name: 'x.pptx', content: '不是 JSON' }]).length, 0, '坏规格应当安静跳过');
assert.equal(collectIllustrationTargets([]).length, 0, '空列表');
assert.equal(collectIllustrationTargets(null).length, 0, 'null 也要能扛住');

// 提示词要截断，避免把一整篇文章塞进生图请求
const long = parseDeckSpec(deck([{ title: 'a', image: { prompt: '画'.repeat(800) } }]));
assert.ok(deckIllustrationRequests(long)[0].prompt.length <= 300, `提示词该被截断，实际 ${deckIllustrationRequests(long)[0].prompt.length}`);

console.log(`P49 illustration planning guard passed（每份最多 ${MAX_ILLUSTRATIONS_PER_DECK} 张；只认 pptx；提示词截断到 300 字）`);
