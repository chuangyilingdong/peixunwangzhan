/**
 * 招生军师的「专家团」：角色定义 + 知识库检索 + 一轮对话。
 *
 * 产品形态：机构**跟 AI 聊**，AI 参考他们自己的资料库来回答，给属于他们自己的答案。
 * 所以这里做三件事：
 *   1. 每个专家绑一个知识域（营销 / 话术 / 文案 / 转化 / 续费 / 合规）；
 *   2. 用户提问时，先用**关键词检索**从 1178 段原文分块里捞出最相关的几段，
 *      连同结构化知识（异议库/文案库/玩法库）一起塞进 system prompt；
 *   3. 把机构画像也塞进去 —— 这是"属于他们自己的答案"的来源。
 *
 * ⚠️ 检索为什么不用向量：语料是**随版本分发的只读 JSON**（约 2.6MB / 1178 段），
 *    中文用二元组（bigram）匹配 + 领域加权已经足够准，而且不需要引入 embedding 服务、
 *    不需要向量库、不会因为换模型而漂。语料再大一个数量级时应当换成向量（那时候再说）。
 *
 * ⚠️ 大模型走的是**平台已有的渠道配置**（platform_settings.ai_provider_policy 的 TEXT 渠道，
 *    生产目前是 DeepSeek：channel-mtp9razp，模型 deepseek-flash / deepseek-v4-pro），
 *    密钥由 services/providerSecret.js 解密 —— 不在这里另配一套 key，
 *    否则后台轮换密钥时这里会静默失效。
 *    ⚠️ 注意 env 里 `AI_PROVIDER=local-mock` 只是**兜底默认**；配了 modalityChannels.TEXT 时
 *       走的是渠道，不是 mock（2026-10-15 实测：真实返回 HTTP 200）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arow } from '../lib.js';
import { getAiProviderPolicy } from '../routes/billingConfig.js';
import { providerSelectionForModality } from '../routes/aiGeneration.js';
import { getGenerationProvider, generationProviderInfo } from './generationProvider.js';
import { isMockProvider } from './providerContract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data/junshi');

let cache = null;
/** 懒加载全部参考数据 + 预建检索索引（进程内常驻，别在请求里读盘）。 */
function data() {
  if (cache) return cache;
  const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  const library = read('library.json');
  const knowledge = read('knowledge.json');
  const compliance = read('compliance.json');
  const chunks = read('chunks.json');
  // 预建 bigram 集合：查询时只做集合命中，不做全文 indexOf（1178 段 × 每次全扫太浪费）
  const indexed = chunks.items.map((c) => {
    const grams = new Set();
    const t = c.text + c.title;
    for (let i = 0; i < t.length - 1; i++) grams.add(t.slice(i, i + 2));
    return { ...c, grams };
  });
  // 文档频率（IDF 用）：每个二元组在多少条里出现过。越稀有 → 越能代表问题的主题。
  // 没有它，「招生/文案/朋友圈」这类泛词会把真正的关键词（比如「寒假」）压下去（实测踩到）。
  const docFreq = (texts) => {
    const m = new Map();
    for (const t of texts) for (const g of new Set(bigrams(t))) m.set(g, (m.get(g) || 0) + 1);
    return m;
  };
  const chunkDf = new Map();
  for (const c of indexed) for (const g of c.grams) chunkDf.set(g, (chunkDf.get(g) || 0) + 1);
  cache = {
    library, knowledge, compliance, chunks: indexed,
    dfs: {
      chunks: { df: chunkDf, total: indexed.length },
      objections: { df: docFreq(knowledge.objections.map((o) => o.q + o.a)), total: knowledge.objections.length },
      copies: { df: docFreq(knowledge.copies.map((c) => c.c)), total: knowledge.copies.length },
      hooks: { df: docFreq(knowledge.hooks.map((h) => h.name + h.rule + h.note)), total: knowledge.hooks.length },
    },
  };
  return cache;
}

/* ───────────── 专家角色 ───────────── */
// 顺序就是界面上的顺序。`domains` 决定检索时优先捞哪个领域的原文分块。
export const EXPERTS = [
  {
    id: 'marketing',
    name: '营销军师',
    tag: '活动策划 · 招生方案 · 全年节奏',
    avatar: '谋',
    domains: ['营销', '团队'],
    intro: '管"这个月打什么仗"：全年节奏、活动方案、钩子玩法、预算和分工。',
    greeting: '我是营销军师。你把要办的活动先说个大概就行——什么时候、什么节点、想拉新还是想课消、大概多少预算。\n\n我会从你这批资料里挑出对得上的玩法给你，再把执行步骤拆开。',
    starters: ['10 月底想办一场万圣节活动，主要让老学员带新朋友', '寒假班怎么招？我只有 3 个校区、主做少儿美术', '上半年淡季怎么安排？感觉 3-4 月没节奏'],
  },
  {
    id: 'script',
    name: '话术教练',
    tag: '地推 · 电话邀约 · 异议处理',
    avatar: '话',
    domains: ['话术'],
    intro: '管"这句话怎么说"：家长一句话问住你了，就来找我。',
    greeting: '我是话术教练。你把家长的原话直接发给我就行，越原汁原味越好——比如"太贵了""我回去和他爸爸商量一下"。\n\n我会告诉你怎么接、按什么顺序接，还有你手上的资料里别人是怎么答的。',
    starters: ['家长说"太贵了"，怎么回？', '地推的时候第三次被拒绝了怎么办', '家长说"已经在别家报了"，还能聊吗'],
  },
  {
    id: 'copy',
    name: '文案写手',
    tag: '朋友圈 · 社群 · 宣传单',
    avatar: '文',
    domains: ['文案'],
    intro: '管"发出去的那段字"：朋友圈、班级群、私信、海报文案。',
    greeting: '我是文案写手。告诉我你要发在哪（朋友圈/班级群/私信）、想推什么、给谁看。\n\n我按你这批资料里的套路给你写，也能直接给你几条现成的改。',
    starters: ['写一条寒假班招生的朋友圈', '这周要发什么内容？帮我排一下', '给我一条劝家长别轻易停课的文案'],
  },
  {
    id: 'convert',
    name: '转化教练',
    tag: '试听 · 公开课 · 家长会 · 逼单',
    avatar: '转',
    domains: ['转化'],
    intro: '管"人来了怎么留住"：试听、公开课、家长会、现场成交。',
    greeting: '我是转化教练。跟我说说你卡在哪一步——是约不来试听，还是试听完了不报名，还是家长会开完没动静。\n\n我会把对应的流程和话术给你，按资料里那套标准动作来。',
    starters: ['试听课家长来了但就是不报名', '家长会怎么开才能带出续费？', '孩子很喜欢，家长说要考虑，怎么推一把'],
  },
  {
    id: 'renew',
    name: '续费管家',
    tag: '续班 · 课消 · 转介绍',
    avatar: '续',
    domains: ['续费', '转介绍'],
    intro: '管"学过的人怎么留下、怎么带人来"：续班、课消、老带新。',
    greeting: '我是续费管家。老生续不上、课时耗得慢、家长不愿意转介绍——这几件事你挑一件说。\n\n我会给你对应的流程、考核口径和说服思路。',
    starters: ['这一期续班率只有 60%，怎么提？', '怎么让家长愿意转介绍？', '课时消耗太慢，怎么催课又不伤感情'],
  },
  {
    id: 'compliance',
    name: '合规顾问',
    tag: '违禁词 · 预收费 · 有奖销售',
    avatar: '规',
    domains: ['合规', '营销'],
    intro: '管"哪些话不能写、哪些玩法有风险"。',
    greeting: '我是合规顾问。把你要发的文案、要办的活动的规则贴给我，我帮你过一遍。\n\n我手上有一份从你全部资料里统计出来的违禁词表，还有几类要特别小心的玩法。',
    starters: ['帮我看看这条文案能不能发', '做"家长合伙人"这种模式有风险吗', '抽奖送课这种活动合规吗'],
  },
];

export function expertById(id) {
  return EXPERTS.find((e) => e.id === id) || EXPERTS[0];
}

/* ───────────── 检索 ───────────── */
/** 中文按二元组切（顺带丢掉标点/空白），"家长嫌贵" → 家长/长嫌/嫌贵。 */
function bigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}\p{S}]/gu, '');
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

/** IDF 权重：越稀有的二元组越值钱。没有它，「招生/文案/朋友圈」这类泛词会压过问题真正的
 *  主题词（实测：问「寒假班文案」，32 条含「寒假」的文案被泛词挤到第 7 名，进不了 top-3）。 */
function idfWeight(stat, gram) {
  return Math.log(1 + stat.total / (1 + (stat.df.get(gram) || 0)));
}

/** 检索前剥掉「请求句」里的指令词。这些词本身也是二元组，会把真正的主题词挤下去——
 *  实测：「写一条寒假班招生的朋友圈文案，30字以内」不剥时，寒假班的文案排第 12；
 *  剥掉「写一条/文案/朋友圈/字以内」后，寒假班排第 2，模型就不会误判「库里没有寒假班」。
 *  full=true 用于结构化检索（文案/朋友圈/话术在整个文案库里是泛词，全部剥掉）；
 *  full=false 用于原文分块（保留「文案/朋友圈」这类可能承载内容语义的词）。 */
const REQUEST_STOP_FULL = ['写一条', '写两条', '帮我写', '帮我', '给我', '写', '一条', '几条', '一篇',
  '文案', '朋友圈', '话术', '软文', '字以内', '以内', '左右', '怎么', '如何', '请问', '一下', '麻烦', '请'];
const REQUEST_STOP_LIGHT = ['写一条', '写两条', '帮我写', '帮我', '给我', '写', '一条', '几条', '一篇',
  '字以内', '以内', '左右', '怎么', '如何', '请问', '一下', '麻烦', '请'];
function stripRequest(s, full) {
  const src = String(s || '');
  let t = src;
  for (const w of (full ? REQUEST_STOP_FULL : REQUEST_STOP_LIGHT)) t = t.split(w).join('');
  return t.trim() || src;
}

// 节点词表：用来判断「这份资料的标题讲的是哪个节点」。命中查询里的节点 → 加分；
// 标题讲的是**另一个**节点 → 扣分。纯词面匹配最容易出的错就是把别的节日的方案拉进来
// （实测：问万圣节，检索把《二月二龙抬头》的活动话术排到了第 1 位，模型还得自己绕开它）。
const NODE_WORDS = ['元旦', '春节', '过年', '新春', '元宵', '情人节', '龙抬头', '女神节', '妇女节', '三八', '植树节', '愚人节',
  '劳动节', '五一', '母亲节', '护士节', '儿童节', '六一', '父亲节', '端午', '七夕', '教师节', '中秋', '国庆', '十一',
  '重阳', '万圣', '感恩节', '圣诞', '双十一', '双11', '双十二', '双12', '开学', '寒假', '暑假', '暑期', '毕业', '周年庆', '店庆'];
// ⚠️ 别名要齐：曾经缺「暑期」，导致暑期方案的标题 nodesOf=[]，
//    节点一致性检查直接跳过 → 问寒假时暑期方案不扣分、反而排到前面（实测踩到）。

function nodesOf(text) {
  return NODE_WORDS.filter((w) => text.includes(w));
}

/**
 * 从原文分块里捞最相关的几段。
 * 打分：命中的查询二元组个数 + 领域加权（专家领域命中 +2）+ 节点一致性（±）。
 * ⚠️ 命中数按**去重后的查询二元组**计（每个 gram 只算一次），
 *    避免一段里反复出现的词把分数拉爆。
 */
export function retrieveChunks(query, domains, limit = 5) {
  const { chunks, dfs } = data();
  const q = stripRequest(query, false);        // 剥掉「写一条/字以内」这类请求词，保留内容词
  const grams = [...new Set(bigrams(q))].slice(0, 60);
  if (!grams.length) return [];
  const asked = nodesOf(q);
  const scored = [];
  for (const c of chunks) {
    let hit = 0; let weight = 0;
    for (const g of grams) if (c.grams.has(g)) { hit += 1; weight += idfWeight(dfs.chunks, g); }
    if (hit < 3) continue;
    let score = weight;                        // IDF 加权分：稀有词权重更高
    if ((c.domain || []).some((d) => domains.includes(d))) score += 2;
    const docNodes = nodesOf(c.title);
    if (asked.length && docNodes.length) {
      const overlap = docNodes.some((n) => asked.includes(n));
      score += overlap ? 3 : -4;              // 同节点加成，别的节点扣分
    }
    scored.push([score, c]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  // 同一份文档最多取 2 段，保证来源分散，别整篇都是同一份
  const out = [];
  const perSrc = new Map();
  for (const [, c] of scored) {
    const n = perSrc.get(c.src) || 0;
    if (n >= 2) continue;
    perSrc.set(c.src, n + 1);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/** 结构化知识：按专家的领域把异议/文案/玩法也捞一份，跟原文分块互补。 */
export function retrieveStructured(query, expertId, limit = 3) {
  const { knowledge, dfs } = data();
  const q = stripRequest(query, true);         // 剥掉指令词与「文案/朋友圈」这类泛词，只留主题
  const grams = [...new Set(bigrams(q))].slice(0, 60);
  const scoreOf = (text, stat) => {
    let raw = 0; let weight = 0;
    for (const g of grams) if (text.includes(g)) { raw += 1; weight += idfWeight(stat, g); }
    return { raw, weight };
  };
  const pick = (list, textOf, strip, stat) => list
    .map((item) => { const s = scoreOf(textOf(item), stat); return { raw: s.raw, weight: s.weight, item }; })
    .filter((x) => x.raw >= 2)
    .sort((a, b) => b.weight - a.weight)       // IDF 加权排序（原先按原始命中数，泛词会压过主题词）
    .slice(0, limit)
    .map((x) => strip(x.item));

  if (expertId === 'script') {
    return { objections: pick(knowledge.objections, (o) => o.q + o.a, (o) => ({ q: o.q, a: o.a.slice(0, 500), cat: o.cat, chain: o.chain || null }), dfs.objections) };
  }
  if (expertId === 'copy') {
    return { copies: pick(knowledge.copies, (c) => c.c, (c) => ({ c: c.c.slice(0, 400), kind: c.kind }), dfs.copies) };
  }
  if (expertId === 'marketing' || expertId === 'compliance') {
    return { hooks: pick(knowledge.hooks, (h) => h.name + h.rule + h.note, (h) => ({ name: h.name, price: h.price, rule: h.rule, note: h.note }), dfs.hooks) };
  }
  return {};
}

/* ───────────── 机构画像 ───────────── */
async function profileFor(ctx) {
  if (!ctx.auth) return null;
  const ownerKey = ctx.auth.user.orgId ? `org:${ctx.auth.user.orgId}` : `user:${ctx.auth.user.id}`;
  const row = await arow('SELECT content FROM junshi_profiles WHERE owner_key=?', [ownerKey]).catch(() => null);
  if (!row) return null;
  try {
    const p = JSON.parse(row.content || '{}');
    const flat = [];
    const labels = {
      name: '机构名称', shortName: '简称', city: '城市', campuses: '校区',
      categories: '课程品类', classTypes: '班型', unitPrice: '课时单价', mainPackage: '主力课包', discountFloor: '优惠底线',
      headcount: '教师人数', education: '学历构成', seniority: '教龄构成', star: '明星教师',
      students: '在读学员', perCampus: '分校区人数', fullRate: '满班率', renewRate: '历史续班率',
      leadCost: '线索成本', visitRate: '到访率', dealRate: '成交率',
      wecomQr: '企业微信', officialAccount: '公众号', douyin: '抖音', phone: '电话', addressScript: '地址话术',
      caseStudy: '学员案例', praise: '家长好评', achievements: '成果数据',
      forbiddenWords: '不能说的词', noPromise: '不能承诺的事', prepayRule: '预收费规则',
    };
    for (const bag of Object.values(p)) {
      if (!bag || typeof bag !== 'object') continue;
      for (const [k, v] of Object.entries(bag)) {
        if (v) flat.push(`${labels[k] || k}：${v}`);
      }
    }
    return flat.length ? flat.join('\n') : null;
  } catch { return null; }
}

/* ───────────── 日期上下文 ───────────── */
/**
 * 把「今天几号、星期几、接下来几个周末是哪两天」喂给模型。
 *
 * ⚠️ 为什么必须喂（2026-10-15 线上实测踩到）：不喂的话模型会**自己猜星期**，
 *    实测它把 10/31 说成周五（实际周六）、把「10/25–26 那个周末」当成周六日
 *    （实际是周日+周一）—— 而这类回答几乎全是排期建议，日期错了整段就废了。
 *    而且它是推理型模型，你越不给事实它越会"推理"出一个错答案。
 * 口径说明：平台面向国内机构，日期一律按 Asia/Shanghai 算（服务器时区是 UTC，
 *    直接用本地时间会差一天）。
 */
function dateContext() {
  const TZ = 'Asia/Shanghai';
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const iso = (d) => d.toISOString().slice(0, 10);
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  // 取该日「北京中午」来算星期：北京 = UTC+8，中午 12:00 即 04:00Z，跨时区不会串日
  const today = new Date(todayIso + 'T04:00:00Z');
  const lines = [`今天是 ${todayIso}（${WD[today.getUTCDay()]}）。`];
  const weekends = [];
  for (let i = 0; i < 80 && weekends.length < 8; i++) {
    const d = new Date(today.getTime() + i * 86400000);
    if (d.getUTCDay() !== 6) continue;                       // 只在周六起算
    const sun = new Date(d.getTime() + 86400000);
    const days = Math.round((d.getTime() - today.getTime()) / 86400000);
    weekends.push(`${iso(d)}（周六）– ${iso(sun)}（周日）${days < 7 ? '（本周末）' : days < 14 ? '（下周末）' : ''}`);
  }
  if (weekends.length) lines.push('接下来的周末：' + weekends.join('；'));
  lines.push('凡是涉及日期排期的建议，一律以上面给的日期和星期为准，不要自己推算星期几。');
  return lines.join('\n');
}

/* ───────────── 提示词 ───────────── */
function buildSystemPrompt({ expert, chunks, structured, profile, compliance }) {
  const parts = [];
  parts.push(`你是「${expert.name}」，${expert.tag}。你服务的是中国教培机构的校长和市场/教务负责人。`);
  parts.push(`\n【今天的日期】\n${dateContext()}`);

  if (profile) {
    parts.push(`\n【这家机构的情况（来自他们自己填的机构画像，回答要结合这些信息，别用"贵机构""XX"这类占位）】\n${profile}`);
  } else {
    parts.push('\n【这家机构还没填机构画像】\n所以你不知道它的品类、价格、校区。如果回答需要这些信息，先用一句话问 1-2 个最关键的（品类 + 规模），别一次问一堆。');
  }

  if (chunks.length) {
    parts.push('\n【从这家机构自己的资料库里检索到的原文（优先用它们回答，能引用原话就引用）】');
    chunks.forEach((c, i) => {
      parts.push(`〔资料${i + 1}〕《${c.title}》\n${c.text}`);
    });
  }

  if (structured.objections?.length) {
    parts.push('\n【资料库里的同类异议与标准答法】');
    structured.objections.forEach((o, i) => {
      parts.push(`〔异议${i + 1}〕家长问：${o.q}\n原文答法：${o.a}`);
      if (o.chain) parts.push(`应答骨架：${o.chain.join(' → ')}`);
    });
  }
  if (structured.copies?.length) {
    parts.push('\n【资料库里的同类文案（改写它们，不要照抄品牌名）】');
    structured.copies.forEach((c, i) => parts.push(`〔文案${i + 1}·${c.kind}〕${c.c}`));
  }
  if (structured.hooks?.length) {
    parts.push('\n【资料库里的同类玩法（规则照抄，价格按这家机构的情况调整）】');
    structured.hooks.forEach((h, i) => parts.push(`〔玩法${i + 1}〕${h.name}（${h.price}）：${h.rule}。注意：${h.note}`));
  }
  if (expert.id === 'compliance' && compliance?.words?.length) {
    parts.push('\n【全库统计出来的高频违禁词（按出现次数排）】');
    parts.push(compliance.words.slice(0, 14).map((w) => `${w.word}（${w.level}）→ ${w.advice}`).join('\n'));
  }

  parts.push(`\n【怎么回答】
1. 说人话，像老同行坐着聊天，别端着、别用"作为AI"这类话。
2. 给**能直接用**的东西：具体的话术原句、步骤、数字、时间点。不要讲空道理。
3. 上面资料里有对得上的内容就用它，并说明来自哪份资料（写清文件标题）。资料里没有的，按教培行业常识答，**并明确说这一段不是来自你的资料库**。
4. 不要编造资料库里没有的案例、数据、政策条文。**引用原话必须是资料里逐字出现的**，别改写后还说是原话。
5. 日期一律用【今天的日期】那一段给的事实，别自己推算星期几。
6. 回答控制在 500 字以内（用户明确要长方案时除外）。用短段落，可以用 1. 2. 3. 列点，**不要用表格**。
7. **同一个问题只问一次**：如果你在开头就问了对方欠缺的信息，结尾不要再问一遍；结尾要么给下一步动作，要么就一个问题都不问。`);

  return parts.join('\n');
}

/* ───────────── 一轮对话 ───────────── */
/**
 * 跑一轮：检索 → 拼提示词 → 流式生成。
 * 回调（由路由写 SSE）：onStatus / onDelta / onReasoning / onCitations。
 */
// 输出预算上限：推理模型先思考再写正文，思考 token 和正文**共用**这个预算，而这条 TEXT 渠道的
// 模板没写 max_tokens —— 上游的默认值会被思考吃光、正文落空（2026-10-15 实测 6 次空 2 次）。
// 32000 ≈ 三万字正文，宽裕到永远轮不到它来截断：上限只兜「模型跑飞」，不做长度限制。
const JUNSHI_MAX_OUTPUT_TOKENS = 32000;

/** 当前 TEXT 渠道是不是本地 mock —— 工作台用它决定是否直接走演示内容，避免先吐一段无关的 mock。 */
export async function textProviderIsMock() {
  const policy = await getAiProviderPolicy();
  const selection = providerSelectionForModality(policy, 'TEXT');
  return isMockProvider(getGenerationProvider(selection).name);
}

/**
 * 跑一段一次性文本生成（合规深度审读用）：与 runChat 走同一条 TEXT 渠道、同一份输出预算，
 * 但不做资料检索、不带专家人设 —— system/user 由调用方给全。
 */
export async function runRawText(ctx, { system, user, messages: providedMessages, onStatus, onDelta, signal, statusLabel = '生成', model: modelOverride = '' }) {  const policy = await getAiProviderPolicy();
  const selection = providerSelectionForModality(policy, 'TEXT', String(modelOverride || '').trim());
  const provider = getGenerationProvider(selection);
  if (typeof provider.generateStream !== 'function') throw new Error('当前 AI 渠道不支持流式生成');
  const messages = Array.isArray(providedMessages) && providedMessages.length
    ? providedMessages
    : [{ role: 'system', content: system }, { role: 'user', content: user }];
  onStatus?.(isMockProvider(provider.name) ? '当前是本地模拟渠道（没配真实模型）' : `正在用 ${selection.model || provider.model || '模型'} ${statusLabel}…`);
  const result = await provider.generateStream({
    messages,
    signal,
    options: { maxTokens: JUNSHI_MAX_OUTPUT_TOKENS },
    onDelta: (chunk) => onDelta?.(chunk),
  });
  return { model: selection.model || provider.model || '', provider: provider.name, usage: result?.usage || null };
}

export async function runChat(ctx, { expertId, messages, signal, onStatus, onDelta, onReasoning, onCitations }) {
  const { compliance } = data();
  const expert = expertById(expertId);
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-12)                                   // 只带最近 12 轮，够用又不至于把上下文撑爆
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser || !lastUser.content.trim()) throw new Error('没有可回答的问题');

  onStatus?.('检索资料库…');
  const chunks = retrieveChunks(lastUser.content, expert.domains, 5);
  const structured = retrieveStructured(lastUser.content, expert.id, 3);
  const profile = await profileFor(ctx);

  const citations = {
    chunks: chunks.map((c) => ({ title: c.title, domain: c.domain, src: c.src, excerpt: c.text.slice(0, 120) })),
    hooks: (structured.hooks || []).map((h) => h.name),
    objections: (structured.objections || []).map((o) => o.q),
    copies: (structured.copies || []).length,
    hasProfile: Boolean(profile),
  };
  onCitations?.(citations);

  const system = buildSystemPrompt({ expert, chunks, structured, profile, compliance });
  const policy = await getAiProviderPolicy();
  const selection = providerSelectionForModality(policy, 'TEXT');
  const info = generationProviderInfo(selection);
  const provider = getGenerationProvider(selection);
  if (typeof provider.generateStream !== 'function') throw new Error('当前 AI 渠道不支持流式对话');

  onStatus?.(isMockProvider(provider.name) ? '当前是本地模拟渠道（没配真实模型）' : `正在用 ${selection.model || provider.model || '模型'} 生成…`);

  // 推理型模型（deepseek-flash）一次回答会吐**几百个** reasoning 增量 —— 实测 485 个。
  // 每个都往前端发一遍是无意义的：前端拿它只是把状态显示成「正在思考」，状态本身不会再变。
  // 所以只转第一个，后面的丢掉（一次回答因此少 ~12KB SSE，前端也少 485 次 DOM 重写）。
  let reasoningSent = false;
  const result = await provider.generateStream({
    messages: [{ role: 'system', content: system }, ...history],
    signal,
    options: { maxTokens: JUNSHI_MAX_OUTPUT_TOKENS },   // 见上方常量说明：保证正文永远写得完
    onDelta: (chunk) => onDelta?.(chunk),
    onReasoning: () => {
      if (reasoningSent) return;
      reasoningSent = true;
      onReasoning?.();
    },
  });

  return {
    model: selection.model || provider.model || '',
    provider: provider.name,
    mode: info.mode,
    citations,
    usage: result?.usage || null,
  };
}
