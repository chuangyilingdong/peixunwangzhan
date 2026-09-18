// P92 实测单价：用「上游逐笔回传的实扣金额」反推我们**真实的**单价（分 / 单位）。
//
// 为什么要有这个数（用户口径 2026-09-18）：
//   「我的诉求就是每个模型我们能知道我们的成本价格。你可以通过 API 来取，如果无法取的可以让我们填。」
//   —— 核实结果：上游**没有价目表 API**（能拉的只有模型清单，不含价格），但**逐笔实扣金额我们已经在收**
//   （compute_attempts.upstream_cost_fen，cost_source='REPORTED'）。所以成本价 = 实扣反推的实测单价为主
//   + 人工可覆盖（价目表里的合同单价仍是我们自己填的，实测只用来校它）。
//
// 只认 cost_source='REPORTED'（上游逐笔回报的真实扣费）。
// ⚠️ **绝不把 COMPUTED 混进来**：COMPUTED 是我们自己拿合同单价 × 用量折出来的 ——
//    把它算进这个比值，就是拿自己的假设证明自己的假设（循环验证），偏差永远为 0，这个数就废了。
//    ESTIMATED / UNKNOWN / MOCK 同理，都不参与（各自只记进 excluded 里，能看见被排除了多少笔）。
//
// 用量从哪来：compute_attempts.usage_snapshot（由 services/upstreamCost.js 的 collectUsageEvidence 写入）。
// 按模态读的**真实字段名**（就是 collectUsageEvidence 写的那几个）：
//   TEXT  → inputTokens + outputTokens（token 个数；两档都齐才会被写入，见该函数）
//   IMAGE → images（张数）+ resolution（档位，仅作提示）
//   VIDEO → seconds（秒数）+ audio（是否含音频，含音频的样本另计 audioSeconds）
//   MUSIC → 按**次**计（一次调用 = 1 单位）；seconds 只作参考，不参与单价（契约里 MUSIC 的主价是 perCallFen）
// 归一后的单位与 services/upstreamCost.js 的 normalizeUpstreamUnitPrices 契约**完全一致**：
//   TEXT 分/百万 token、IMAGE 分/张、VIDEO 分/秒、MUSIC 分/次。
//
// 只有**金额与用量都齐**的样本才参与：否则会拿「全部样本的钱」除以「部分样本的用量」，单价虚高。
// 缺用量的那些笔单独计数（excluded.noUnits），页面上会说清「有实扣但取不到用量，反推不了」——
// 这是最要紧的一种沉默失真：某个模态上游不回用量时，这里必须显示"测不出来"，而不是给个假数。
//
// 样本太少不给结论：默认 < 3 笔 → measuredUnitPrice = null 且 insufficient = 'TOO_FEW_SAMPLES'。
// 绝不给 0，也绝不拿 1 笔样本当结论（一次促销价、一次重试都可能把单价带偏）。
// 完全没有 REPORTED 样本的组合也会列出（insufficient = 'NO_REPORTED_SAMPLES'）——
// 「这个渠道这个模型上游从没回过实扣」必须看得见，不能被显示成"没数据"。
//
// 精度：账本里的 upstream_cost_fen 是**整数分**（上游金额 ×100 后四舍五入，见 openaiCompatibleProvider.reportedCost）。
// 文本一次调用常常只有零点几分，逐笔取整会把它记成 0 分 —— 一千次调用合起来单价会被压成 0。
// 所以金额优先取 cost_rule_snapshot 里的**未取整原始值**：
//   reportedCostRuleSnapshot 把上游原样回传的 upstreamAmount（元，未取整）留在了快照里，
//   这里用 json_extract(cost_rule_snapshot,'$.upstreamAmount')*100 还原成分（带小数）。
// 快照里没有（老数据）才回退 upstream_cost_fen。两者都返回给调用方：
//   totalCostFen  = 未取整合计（**用来算单价的就是它**）
//   ledgerCostFen = 账本整数分合计（对账用，两者差额就是逐笔取整损失）
//
// 改价不追溯：这个服务只读历史，不写任何配置。写合同单价是人在页面上点「采纳为成本价」的事。

import { row, rows } from '../lib.js';

const MODALITIES = Object.freeze(['TEXT', 'IMAGE', 'VIDEO', 'MUSIC']);
const MIN_SAMPLES_DEFAULT = 3;
const MAX_DAYS = 365;
const DAY_MS = 86400000;

/** 计价单位契约（与 upstreamCost.normalizeUpstreamUnitPrices 一致，别在这里另发明一种）。 */
export const MEASURED_UNITS = Object.freeze({
  TEXT: Object.freeze({ label: '分/百万 token', scale: 1000000, fields: Object.freeze(['inputFenPer1MTokens', 'outputFenPer1MTokens']) }),
  IMAGE: Object.freeze({ label: '分/张', scale: 1, fields: Object.freeze(['perImageFen']) }),
  VIDEO: Object.freeze({ label: '分/秒', scale: 1, fields: Object.freeze(['perSecondFen', 'audioExtraPerSecondFen']) }),
  MUSIC: Object.freeze({ label: '分/次', scale: 1, fields: Object.freeze(['perCallFen', 'perSecondFen']) }),
});

/** usage_snapshot 里的字段读取；非 JSON / 空值一律当"没有"（绝不抛错、绝不按 0 混进用量）。 */
const snap = (path) => `(CASE WHEN json_valid(usage_snapshot) THEN json_extract(usage_snapshot,'${path}') END)`;

/** 一条样本在这次统计里的"用量"，单位按模态（MUSIC 按次 = 1）。 */
const unitSql = (column) => `CASE ${column} WHEN 'TEXT' THEN (COALESCE(${snap('$.inputTokens')},0)+COALESCE(${snap('$.outputTokens')},0)) WHEN 'IMAGE' THEN COALESCE(${snap('$.images')},0) WHEN 'VIDEO' THEN COALESCE(${snap('$.seconds')},0) WHEN 'MUSIC' THEN 1 ELSE 0 END`;

/** 未取整的实扣金额（分）：优先快照里的原始元值 ×100，没有才用账本整数分。 */
const costSql = `COALESCE((CASE WHEN json_valid(cost_rule_snapshot) THEN json_extract(cost_rule_snapshot,'$.upstreamAmount') END)*100, upstream_cost_fen)`;

function normalizeDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_DAYS);
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/**
 * 按 (渠道 × 模型 × 模态) 反推实测单价。
 *
 * @param {object} options
 * @param {number} [options.days]        回看天数（1..365，默认 30）
 * @param {number} [options.minSamples]  样本量阈值（默认 3；低于它不给单价）
 * @param {Date|string} [options.now]    统计截止时间（默认现在；守卫用它固定窗口）
 * @returns {{days:number,since:string,until:string,minSamples:number,onlyCostSource:string,items:Array,excluded:object,meta:object}}
 */
export function measuredUnitPrices({ days = 30, minSamples = MIN_SAMPLES_DEFAULT, now = null } = {}) {
  const normalizedDays = normalizeDays(days);
  const normalizedMinSamples = Number.isFinite(Number(minSamples)) ? Math.max(1, Math.trunc(Number(minSamples))) : MIN_SAMPLES_DEFAULT;
  const untilDate = now ? new Date(now) : new Date();
  const until = untilDate.toISOString();
  const since = new Date(untilDate.getTime() - normalizedDays * DAY_MS).toISOString();
  const unitExpr = unitSql('UPPER(modality)');
  const usableExpr = `(upstream_cost_fen IS NOT NULL AND (${unitExpr})>0)`;

  // 一次 SQL 把「同一 (渠道,模型,模态,来源)」的行合起来：内存里只按组算，不逐行拉回。
  const groups = rows(`
    SELECT channel_id, model, UPPER(modality) modality, UPPER(cost_source) cost_source,
      COUNT(*) samples,
      SUM(CASE WHEN ${usableExpr} THEN 1 ELSE 0 END) usableSamples,
      SUM(CASE WHEN upstream_cost_fen IS NULL THEN 1 ELSE 0 END) noAmount,
      SUM(CASE WHEN upstream_cost_fen IS NOT NULL AND (${unitExpr})=0 THEN 1 ELSE 0 END) noUnits,
      SUM(CASE WHEN ${usableExpr} THEN ${costSql} ELSE 0 END) rawCostFen,
      SUM(CASE WHEN ${usableExpr} THEN upstream_cost_fen ELSE 0 END) ledgerCostFen,
      SUM(CASE WHEN ${usableExpr} THEN (${unitExpr}) ELSE 0 END) units,
      SUM(CASE WHEN ${usableExpr} THEN COALESCE(${snap('$.inputTokens')},0) ELSE 0 END) inputTokens,
      SUM(CASE WHEN ${usableExpr} THEN COALESCE(${snap('$.outputTokens')},0) ELSE 0 END) outputTokens,
      SUM(CASE WHEN ${usableExpr} THEN COALESCE(${snap('$.images')},0) ELSE 0 END) images,
      SUM(CASE WHEN ${usableExpr} THEN COALESCE(${snap('$.seconds')},0) ELSE 0 END) seconds,
      SUM(CASE WHEN ${usableExpr} AND ${snap('$.audio')}=1 THEN COALESCE(${snap('$.seconds')},0) ELSE 0 END) audioSeconds,
      SUM(CASE WHEN ${usableExpr} AND ${snap('$.audio')}=1 THEN 1 ELSE 0 END) audioSamples,
      COUNT(DISTINCT CASE WHEN json_valid(usage_snapshot) THEN json_extract(usage_snapshot,'$.resolution') END) resolutionCount,
      MIN(created_at) firstAt, MAX(created_at) lastAt
    FROM compute_attempts
    WHERE status='SUCCESS' AND created_at>=? AND created_at<?
    GROUP BY channel_id, model, UPPER(modality), UPPER(cost_source)`, [since, until]);

  const byKey = new Map();
  const excluded = { nonSuccess: 0, otherModality: 0, noAmount: 0, noUnits: 0, bySource: {}, scannedGroups: groups.length };
  for (const group of groups) {
    const source = String(group.cost_source || 'UNKNOWN');
    const modality = String(group.modality || '');
    if (!MODALITIES.includes(modality)) {
      excluded.otherModality += Number(group.samples || 0);
      continue;
    }
    const key = `${group.channel_id ?? ''}\u0000${group.model ?? ''}\u0000${modality}`;
    const entry = byKey.get(key) || {
      channelId: group.channel_id ?? null, model: group.model ?? null, modality,
      unitLabel: MEASURED_UNITS[modality].label, unitScale: MEASURED_UNITS[modality].scale,
      sampleCount: 0, samples: 0, totalCostFen: 0, ledgerCostFen: 0, totalUnits: 0,
      inputTokens: 0, outputTokens: 0, images: 0, seconds: 0, audioSeconds: 0, audioSamples: 0,
      resolutionCount: 0, firstAt: null, lastAt: null,
      excluded: { samples: 0, noAmount: 0, noUnits: 0, bySource: {} },
      reportedSamples: 0,
    };
    byKey.set(key, entry);
    entry.samples += Number(group.samples || 0);
    entry.resolutionCount = Math.max(entry.resolutionCount, Number(group.resolutionCount || 0));
    if (group.firstAt && (!entry.firstAt || group.firstAt < entry.firstAt)) entry.firstAt = group.firstAt;
    if (group.lastAt && (!entry.lastAt || group.lastAt > entry.lastAt)) entry.lastAt = group.lastAt;
    // 全量口径的"缺金额 / 缺用量"计数（不分来源）：这两个数是"我们测不出来的部分"，要能一眼看到。
    excluded.noAmount += Number(group.noAmount || 0);
    excluded.noUnits += Number(group.noUnits || 0);
    if (source === 'REPORTED') {
      entry.reportedSamples += Number(group.samples || 0);
      entry.sampleCount += Number(group.usableSamples || 0);
      entry.totalCostFen += Number(group.rawCostFen || 0);
      entry.ledgerCostFen += Number(group.ledgerCostFen || 0);
      entry.totalUnits += Number(group.units || 0);
      entry.inputTokens += Number(group.inputTokens || 0);
      entry.outputTokens += Number(group.outputTokens || 0);
      entry.images += Number(group.images || 0);
      entry.seconds += Number(group.seconds || 0);
      entry.audioSeconds += Number(group.audioSeconds || 0);
      entry.audioSamples += Number(group.audioSamples || 0);
      entry.excluded.samples += Number(group.samples || 0) - Number(group.usableSamples || 0);
      entry.excluded.noAmount += Number(group.noAmount || 0);
      entry.excluded.noUnits += Number(group.noUnits || 0);
      // 缺用量的笔单独记：这是"测不出来"与"测出来是 0"的分界，报告里要点名。
      if (Number(group.noAmount || 0) === 0 && Number(group.usableSamples || 0) === 0) entry.excluded.bySource.REPORTED_NO_USAGE = (entry.excluded.bySource.REPORTED_NO_USAGE || 0) + Number(group.samples || 0);
      continue;
    }
    // 非 REPORTED：只计数（**绝不参与单价**，见文件头）。
    entry.excluded.bySource[source] = (entry.excluded.bySource[source] || 0) + Number(group.samples || 0);
    excluded.bySource[source] = (excluded.bySource[source] || 0) + Number(group.samples || 0);
  }

  const nonSuccess = Number(row("SELECT COUNT(*) n FROM compute_attempts WHERE status<>'SUCCESS' AND created_at>=? AND created_at<?", [since, until])?.n || 0);
  excluded.nonSuccess = nonSuccess;

  const items = [];
  for (const entry of byKey.values()) {
    // 样本构成决定"为什么没有单价"。**只有非 REPORTED 样本的组合也要出现在列表里**：
    // 「这个渠道这个模型上游从没回过实扣」本身就是必须让人看见的事实（否则页面显示成"没数据"，
    // 分不清是"没人用"还是"上游不回实扣"）。
    let insufficientReason = null;
    if (!entry.reportedSamples) insufficientReason = 'NO_REPORTED_SAMPLES';
    else if (entry.sampleCount === 0) insufficientReason = Number(entry.excluded.noUnits || 0) > 0 ? 'NO_USAGE_IN_SNAPSHOT' : 'NO_REPORTED_SAMPLES';
    else if (entry.sampleCount < normalizedMinSamples) insufficientReason = 'TOO_FEW_SAMPLES';
    else if (!(entry.totalUnits > 0)) insufficientReason = 'NO_USAGE_IN_SNAPSHOT';
    const measured = insufficientReason ? null : Math.round((entry.totalCostFen / entry.totalUnits) * entry.unitScale);
    items.push({
      channelId: entry.channelId, model: entry.model, modality: entry.modality,
      unitLabel: entry.unitLabel, unitScale: entry.unitScale,
      sampleCount: entry.sampleCount,
      reportedSamples: entry.reportedSamples,
      totalCostFen: round(entry.totalCostFen, 4),
      ledgerCostFen: Math.round(entry.ledgerCostFen),
      totalUnits: Math.round(entry.totalUnits * 10000) / 10000,
      measuredUnitPrice: measured,
      insufficient: measured === null,
      insufficientReason,
      units: {
        inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, tokens: entry.inputTokens + entry.outputTokens,
        images: entry.images, seconds: round(entry.seconds, 4), audioSeconds: round(entry.audioSeconds, 4),
        audioSamples: entry.audioSamples, calls: entry.modality === 'MUSIC' ? entry.sampleCount : 0,
        resolutionCount: entry.resolutionCount,
      },
      firstAt: entry.firstAt, lastAt: entry.lastAt,
      excluded: { samples: entry.excluded.samples, noAmount: entry.excluded.noAmount, noUnits: entry.excluded.noUnits, bySource: entry.excluded.bySource },
    });
  }
  items.sort((left, right) => String(left.channelId || '').localeCompare(String(right.channelId || ''))
    || String(left.model || '').localeCompare(String(right.model || ''))
    || left.modality.localeCompare(right.modality));

  return {
    days: normalizedDays, since, until,
    minSamples: normalizedMinSamples,
    onlyCostSource: 'REPORTED',
    items,
    excluded,
    meta: {
      basis: 'UPSTREAM_REPORTED_ONLY',
      table: 'compute_attempts',
      filter: "status='SUCCESS' AND cost_source='REPORTED' AND upstream_cost_fen IS NOT NULL",
      exclusion: 'COMPUTED（我们自己按合同单价折算的）不计入 —— 那是拿假设证明假设。ESTIMATED / UNKNOWN / MOCK 同样不计入。',
      costPrecision: 'totalCostFen 用 cost_rule_snapshot.upstreamAmount×100（未取整）还原；ledgerCostFen 是账本整数分合计，差额 = 逐笔取整损失。',
      usageFields: {
        TEXT: 'usage_snapshot.inputTokens + outputTokens（token 数；单价换算成分/百万 token）',
        IMAGE: 'usage_snapshot.images（张数）+ resolution（档位提示）',
        VIDEO: 'usage_snapshot.seconds（秒数）+ audio（含音频时另计 audioSeconds）',
        MUSIC: '按次（一笔实扣 = 1 次）；usage_snapshot.seconds 仅作参考',
      },
      minSamples: normalizedMinSamples,
      unavailable: 'usage_snapshot 取不到用量（上游不回 / 老数据没有该列）时不给单价，标 NO_USAGE_IN_SNAPSHOT。',
    },
  };
}

/** 端点/页面上要展示的"样本不足"等文案与阈值说明（只读常量）。 */
export const MEASURED_PRICE_RULES = Object.freeze({
  minSamples: MIN_SAMPLES_DEFAULT,
  maxDays: MAX_DAYS,
  formula: '实测单价 = 上游逐笔实扣金额 ÷ 同一批样本的用量',
  sourceNote: '只统计上游逐笔回报的实扣（REPORTED），不含我们自己按合同价折算的（COMPUTED）。',
});

export { MODALITIES as MEASURED_MODALITIES };

/** 供测试/文档用的导出（内部口径常量）。 */
export const __internals = Object.freeze({ normalizeDays, round });
