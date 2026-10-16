/**
 * 教培物料 · 合规引擎 + AI 审读提示词
 *
 * 移植自 traffic-compass（github.com/code-wahaha/traffic-compass，MIT © code-wahaha）的
 * webapp/engine.py 与 webapp/audit_skill.md，保留它的核心设计与「防误杀」口径：
 *   1) L2 违禁词 + L3 白名单（正常词放行，不报）
 *   2) 语境窗口：极限词只在「营销语境」里按原严重度算；周围没有营销词 → 降为低危提示，不"见词就杀"
 *   3) 命中词做子串去重（100% ⊂ 100%有效 时只留长的）
 *   4) 资质红线单列，与违禁词分开给结论
 *   5) 总体结论三档：可发 / 改完可发 / 高风险勿发
 * 去掉的：抖音流量预测模型（不适用于朋友圈/海报）；抖音 AI 双标注提醒（换到 prompt 里按需说）。
 * 规则数据在 data/junshi/compliance-rules.json，来源与改写口径写在那份文件的 source 字段里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(__dirname, '../../data/junshi/compliance-rules.json');

/** 营销语境关键词：判断极限词是否处在推销语境（防误杀核心）。
 *  前半是原项目（抖音带货）的词，后半是教培场景补词 —— 没有这半边，
 *  「烟台最大的美术教育机构」这种明显广告会被当成日常口语放过去（实测踩到过）。
 *  ⚠️ 故意不收「老师 / 家长」这类歧义词：「老师说她进步最大」是客观转述，不该判违规。 */
const MARKETING_HINTS = ['买', '购', '下单', '优惠', '价', '抢', '秒杀', '折', '促销', '店', '货',
  '链接', '领', '券', '包邮', '限时', '到手', '原价', '现价', '拍下', '成交',
  '机构', '培训', '课程', '报名', '招生', '学费', '校区', '试听', '体验课', '学员', '升班', '续报'];
/** 只看语境的极限词：周围没有营销词就降为提示（不是删除） */
const SOFT_SAFE_WORDS = new Set(['最', '唯一', '顶级', '最佳', '最优', '最好', '最大', '最强', '最靠谱']);
/** 语境窗口：命中词左右各看多少字 */
const WIN = 12;

let cachedPack = null;
export function loadPack() {
  if (!cachedPack) cachedPack = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  return cachedPack;
}

const countOf = (text, word) => text.split(word).length - 1;

export function scanText(text, pack = loadPack()) {
  const src = String(text || '');
  const marketing = MARKETING_HINTS.some((h) => src.includes(h));
  const whitelistWords = new Set();
  (pack.l3_whitelist || []).forEach((g) => (g.words || []).forEach((w) => whitelistWords.add(w)));

  const hits = [];
  const whitelist = [];
  const seen = new Set();

  (pack.l2 || []).forEach((entry) => {
    (entry.words || []).forEach((word) => {
      if (!src.includes(word) || seen.has(word)) return;
      // L3 白名单：精确命中白名单词 → 放行并说明（防误杀）
      if (whitelistWords.has(word)) {
        whitelist.push(`「${word}」是正常用语，此处安全`);
        seen.add(word);
        return;
      }
      // 看语境的极限词：一律列出，但语境决定严重度
      if (SOFT_SAFE_WORDS.has(word)) {
        const i = src.indexOf(word);
        const win = src.slice(Math.max(0, i - WIN), i + word.length + WIN);
        if (!MARKETING_HINTS.some((h) => win.includes(h))) {
          hits.push({
            word, category: entry.category, severity: 'low', count: countOf(src, word),
            replace: entry.replace, note: '疑似正常语境（周围没有营销词），但属敏感词，请自行确认',
          });
          seen.add(word);
          return;
        }
      }
      hits.push({
        word, category: entry.category, severity: entry.severity, count: countOf(src, word),
        replace: entry.replace, note: entry.note || '',
      });
      seen.add(word);
    });
  });

  // 子串去重：某命中词是另一命中词的子串时，丢掉短的（保留更具体的）
  const wordsNow = hits.map((h) => h.word);
  const deduped = hits.filter((h) => !wordsNow.some((o) => o !== h.word && o.includes(h.word)));

  // 资质红线（与违禁词分开，命中即高风险）
  const redlines = [];
  (pack.qual_redlines || []).forEach((r) => {
    const trigger = (r.trigger || []).find((t) => src.includes(t));
    if (trigger) redlines.push({ field: r.field, trigger, note: r.note, severity: 'high' });
  });

  const rank = { high: 0, mid: 1, low: 2 };
  deduped.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (b.count - a.count));
  return { hits: deduped, whitelist, redlines, marketing, chars: src.length };
}

export function verdictOf(scan) {
  const high = scan.hits.filter((h) => h.severity === 'high');
  if (scan.redlines.length) return { level: 'block', text: '高风险勿发：触碰资质红线' };
  if (high.length >= 3) return { level: 'block', text: '高风险勿发：违规较重，改完再发' };
  if (high.length) return { level: 'fix', text: '改完可发：处理下面标红的几个词' };
  if (scan.hits.some((h) => h.severity === 'mid')) return { level: 'fix', text: '建议优化后发：有需要调整的表述' };
  return { level: 'ok', text: '没发现问题，可以发' };
}

export function audit(text) {
  const pack = loadPack();
  const scan = scanText(text, pack);
  return { pack: { id: pack.id, name: pack.name, updated: pack.updated, source: pack.source }, scan, verdict: verdictOf(scan) };
}

/**
 * AI 深度审读提示词 —— 从 traffic-compass 的 audit_skill.md 改写：
 *   保留：读语境判定（重点防误杀）、最小改动建议（保留作者口语腔）、严格 JSON 输出
 *   去掉：ASR 纠错（我们收的是书面物料，不是语音转写）、抖音流量潜力评分（不适用）
 *   增加：教培高频雷区（承诺升学/师资夸大/成绩宣传）与「已放行」说明
 */
export const AUDIT_PROMPT = `你是教培行业的资深招生文案操盘手 + 广告合规审核专家。用户会给你一段教培机构的宣传物料（朋友圈文案 / 海报文字 / 群公告 / 招生活术话术）。一次性做完下面三件事，**严格只输出一个 JSON 对象**（不要解释、不要 markdown 代码块、不要 JSON 之外的任何字符）。

═══════════════════════════════
## 任务：违规审核（读语境判断，别见词就杀）
### A 绝对违规（出现即违规）
- 承诺类 high：包过/保过/保录取/包升学/保分/提分保证/学不会退款/一次通关
- 成绩宣传 high：升学率/状元/中高考成绩/成绩排名（教育部「十项严禁」口径，不得宣传）
- 绝对化 high：100%有效/绝对/必定/根治/永久/无敌/万能/零风险/立竿见影
- 权威虚标 high：国家级/世界级/官方指定/国家认证/央视推荐/驰名商标/质量免检
- 诱导营销 high：秒杀/抢疯了/再不买就没了/最后机会/跳楼价/全网抄底价
- 封建迷信 high：改运/招财/算命/看相/风水/转运/辟邪
- 师资夸大 high：名师/资深教师/名校毕业/名师团队（无资质证明不得使用）
- 资质红线 high：医疗健康（诊断/治疗/偏方）、金融投资（稳赚不赔/保本/荐股）、法律咨询、押题与有偿补课
- 虚假宣传 mid：神器/黑科技/躺赚/一夜暴富/零成本创业
- 速成夸大 mid：7天速成/30天精通/三天学会
- 价格表述 mid：0元购/免费学/完全免费（写清条件才可用）
- 微信生态 mid：转发朋友圈领/集赞/拉人进群/邀请好友得（诱导分享违反微信平台规范）

### B 语境违规（必须读懂句子，重点别误杀）
极限词：最/第一/全网第一/唯一/独家/顶级/最佳/最优/最好/最大/最强
- **high**：吹自己机构/课程/效果的对比夸大——「全网最好的课」「效果第一」「唯一能……的方法」
- **low + note「疑似正常表达，请自行确认」**：客观陈述（「唯一不同的是……」）、情感表达（「最伟大的妈妈」）、家长口碑转述（「我家孩子进步最大」）
- **碰到这些词仍一律列进 violations**，语境只决定 severity，别漏也别当 high 吓人。

### C 教培物料高发雷区（重点查）
- **效果承诺**：提分 X 分 / 一个月见效 / 学不会全退 → 改「按课时计划推进，阶段评估，个体差异存在」
- **师资无凭据**：名师/资深/名校 → 改「有教师资格证的专职老师」「教龄 X 年」
- **制造焦虑过度**：再不学就跟不上/别人孩子都在学 → 改「多一个选择，按孩子节奏来」
- **转介绍诱导**：拉人送课时/转发得礼 → 改「老家长推荐可享 X（不附加分享动作）」
- **AI 生成内容**：物料像 AI 生成或提到用 AI 创作 → 不计违规，写进 improvements 提醒按平台要求标注

每个违规项：{text, severity(high|mid|low), category, reason, suggest(保留作者口语腔、最小改动), note}

═══════════════════════════════
## 任务：最小改动建议（improvements 要具体可落地，不许只说"建议加强"）
- 命中违规的：给**改后的整句**（保留原句的口语腔与节奏，只换那几个词），不要重写成 AI 腔
- 合规但表达弱的：最多给 2 条最有价值的建议（比如把「效果好」换成具体可核实的描述）

═══════════════════════════════
## 严格只输出这个 JSON：
{
 "violations": [{"text":"原文里命中的片段","severity":"high","category":"","reason":"","suggest":"改后的整句","note":""}],
 "whitelist_notes": ["放行说明，如「最」在情感表达里正常——按语境已放行"],
 "highlights": ["写得好的地方"],
 "improvements": ["具体可落地的建议，含 AI 标注提醒如适用"],
 "summary": "一句话定性，并注明：这是文案维度审核，不替代法律意见"
}`;
