// 算力池（学生 × 课包）：一个学生在一个课包上的总预算，**对话 / 图片 / 视频 / 音乐共用一个池子**。
//
// 为什么闸门在应用侧而不是网关（2026-09-12 用户拍板后的必然结果）：
//   · 用户口径是「四种模态都算进这一个上限」；
//   · 但视频与音乐在我们的上游是「提交 + 轮询」的异步任务，new-api 要接它们得写任务插件
//     （写了那部分就受 AGPL-3.0 约束，见梳理文档 7.2.3）→ 这两类走我们自己的出口，网关看不见；
//   · 于是**只有应用侧能同时看见四种模态** → 池子的权威账本只能是应用侧的 usage_records.cost_fen，
//     网关的令牌额度退化成宽松兜底（它只认得对话与图片）。
//
// 记账口径（**预扣 + 结算**，都是「每次调用单价」折算）：
//   · 调用前：`assertComputePoolBudget()` 按本次单价预估，超了就拦（错误码 COMPUTE_POOL_EXHAUSTED）；
//   · 调用后：成功按单价记一笔 cost_fen，失败记 0（不花学生的钱）。
//   单价是平台端的「每次调用预估单价」（platform_settings.compute_pricing），**不是上游账单**；
//   对话/图片的精确账单在网关用量日志里，可以拿来对账（梳理文档 7.4 的待办）。
import { errors } from '../lib.js';
import { row, rows, q, nowIso, parseJson, json } from '../lib.js';

const MODALITIES = ['TEXT', 'IMAGE', 'VIDEO', 'MUSIC'];

/**
 * 预置的每次调用预估单价（分）。**必须按自己的渠道价改** —— 这只是让池子一上线就有数可算，
 * 不是真实成本（真实成本要以网关用量日志/上游账单为准）。留一个非 0 的默认值还有个好处：
 * 不会因为「平台忘了配价」把学生的每一次调用都拦死。
 */
const DEFAULT_PER_CALL_FEN = Object.freeze({ TEXT: 10, IMAGE: 100, VIDEO: 500, MUSIC: 200 });

export function getComputePricing() {
  const value = parseJson(row('SELECT compute_pricing FROM platform_settings WHERE id=1')?.compute_pricing, {});
  const perCall = {};
  for (const modality of MODALITIES) {
    const raw = value?.perCall?.[modality];
    perCall[modality] = raw === undefined || raw === null || raw === '' ? DEFAULT_PER_CALL_FEN[modality] : Math.max(0, Math.round(Number(raw) || 0));
  }
  const models = {};
  for (const [model, price] of Object.entries(value?.models && typeof value.models === 'object' ? value.models : {})) {
    const fen = Math.max(0, Math.round(Number(price) || 0));
    if (String(model).trim()) models[String(model).trim()] = fen;
  }
  return { perCall, models, updatedAt: value?.updatedAt || null };
}

export function saveComputePricing(patch = {}) {
  const current = getComputePricing();
  const nextPerCall = { ...current.perCall };
  for (const modality of MODALITIES) {
    if (patch?.perCall?.[modality] === undefined) continue;
    nextPerCall[modality] = Math.max(0, Math.round(Number(patch.perCall[modality]) || 0));
  }
  let nextModels = current.models;
  if (patch?.models && typeof patch.models === 'object') {
    nextModels = {};
    for (const [model, price] of Object.entries(patch.models)) {
      const name = String(model).trim();
      if (!name) continue;
      nextModels[name] = Math.max(0, Math.round(Number(price) || 0));
    }
  }
  q('UPDATE platform_settings SET compute_pricing=? WHERE id=1', [json({ perCall: nextPerCall, models: nextModels, updatedAt: nowIso() })]);
  return getComputePricing();
}

/** 这一次调用的单价（分）：模型级单价优先，否则按模态的默认单价。 */
export function priceFenFor({ modality, model = '' } = {}) {
  const pricing = getComputePricing();
  const key = String(model || '').trim();
  if (key && Object.prototype.hasOwnProperty.call(pricing.models, key)) return Number(pricing.models[key]);
  return Number(pricing.perCall[String(modality || '').toUpperCase()] ?? 0);
}

/** 课包的「每学生算力上限」（分）；没填 → null = 不拦，只记账。 */
export function seriesBudgetFen(seriesId) {
  if (!seriesId) return null;
  const value = row('SELECT per_student_budget_fen FROM course_series WHERE id=?', [seriesId])?.per_student_budget_fen;
  if (value === null || value === undefined) return null;
  const fen = Number(value);
  return Number.isFinite(fen) && fen > 0 ? Math.round(fen) : null;
}

/** 这个学生在这个课包上已经花掉多少（分）——只算成功的调用（失败记 0，不占预算）。 */
export function poolUsedFen({ userId, seriesId }) {
  if (!userId || !seriesId) return 0;
  const value = row("SELECT COALESCE(SUM(cost_fen),0) AS n FROM usage_records WHERE user_id=? AND series_id=? AND status='SUCCESS'", [userId, seriesId])?.n;
  return Math.max(0, Math.round(Number(value) || 0));
}

/** 平台端/机构端看池子用：上限 / 已用 / 剩余 / 使用率。 */
export function computePoolStatus({ userId, seriesId }) {
  const capFen = seriesBudgetFen(seriesId);
  const usedFen = poolUsedFen({ userId, seriesId });
  return {
    seriesId: seriesId || null,
    capFen,
    usedFen,
    remainFen: capFen === null ? null : Math.max(0, capFen - usedFen),
    unlimited: capFen === null,
    usagePercent: capFen ? Number(((usedFen / capFen) * 100).toFixed(1)) : null,
  };
}

/**
 * 平台端「算力池」报表：每个 (学员 × 课包) 一行 —— 上限 / 已用 / 剩余 / 使用率 + 名字。
 * 只列**有消耗记录**的池子（用池子的人才有必要看）；课包预算留空的池子标 unlimited。
 */
export function computePoolReport({ limit = 100 } = {}) {
  const list = rows(
    `SELECT record.user_id AS userId, record.series_id AS seriesId,
            COALESCE(SUM(record.cost_fen),0) AS usedFen,
            COUNT(*) AS calls,
            SUM(CASE WHEN record.status='SUCCESS' THEN 1 ELSE 0 END) AS successCalls,
            SUM(CASE WHEN record.status!='SUCCESS' THEN 1 ELSE 0 END) AS failedCalls,
            MAX(record.created_at) AS lastAt,
            student.display_name AS studentName, student.login AS studentLogin,
            org.name AS orgName, series.title AS seriesTitle,
            series.per_student_budget_fen AS capFen
       FROM usage_records record
       LEFT JOIN users student ON student.id = record.user_id
       LEFT JOIN organizations org ON org.id = record.org_id
       LEFT JOIN course_series series ON series.id = record.series_id
      WHERE record.series_id IS NOT NULL
      GROUP BY record.user_id, record.series_id
      ORDER BY usedFen DESC, lastAt DESC
      LIMIT ?`,
    [Math.max(1, Math.round(Number(limit) || 100))],
  );
  const toYuan = (fen) => Number((Number(fen || 0) / 100).toFixed(2));
  return list.map((item) => {
    const capFen = item.capFen === null || item.capFen === undefined ? null : Number(item.capFen);
    const usedFen = Math.max(0, Math.round(Number(item.usedFen) || 0));
    return {
      userId: item.userId, seriesId: item.seriesId,
      studentName: item.studentName || item.studentLogin || item.userId,
      orgName: item.orgName || '—', seriesTitle: item.seriesTitle || item.seriesId,
      capFen, usedFen,
      capYuan: capFen === null ? null : toYuan(capFen), usedYuan: toYuan(usedFen),
      remainFen: capFen === null ? null : Math.max(0, capFen - usedFen),
      remainYuan: capFen === null ? null : toYuan(Math.max(0, capFen - usedFen)),
      unlimited: capFen === null,
      usagePercent: capFen ? Number(((usedFen / capFen) * 100).toFixed(1)) : null,
      calls: Number(item.calls || 0), successCalls: Number(item.successCalls || 0), failedCalls: Number(item.failedCalls || 0),
      lastAt: item.lastAt || null,
    };
  });
}

/**
 * 对账：**池子账（应用侧，四种模态、按单价折算）** vs **网关账（精确，只含对话/图片）**。
 *
 * 为什么必须对账：这两本是**不同的账**，而且差在哪是能解释的 ——
 *   ① 网关看不见视频/音乐 → 这部分只可能出现在池子账里（不是错，是口径不同）；
 *   ② 对话/图片两边都有，但池子是「每次调用单价 × 次数」折算的**预估**，网关是按 token 实算的**精确**，
 *      两者之差就是**单价折算误差** —— 调单价看这一个数就行。
 * 所以对账的比法是：**只拿重叠模态（TEXT/IMAGE）比**，差额表里写成「预估误差」；
 * 视频/音乐单列一列，明确标注「网关看不见」。
 *
 * `days` 窗口按 usage_records.created_at 与网关日志的 start_timestamp 各算各的（同一天数）。
 * **什么时候不能对账**：这段时间网关没启用（或没有对话/图片调用）→ 网关账为 0，
 * 这时不给百分比（避免出现「误差 100%」这种会被误解成 bug 的数），标 `NO_GATEWAY_DATA`。
 */
export async function computePoolReconciliation({ days = 7 } = {}) {
  const { listGatewayLogs, getComputeGatewayConfig, parseTokenSegments } = await import('./computeGateway.js');
  const config = getComputeGatewayConfig();
  const quotaPerUnit = Number(config.quotaPerUnit || 500000);
  const sinceIso = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();

  // ① 池子账（应用侧）：学员 × 课包 × 模态
  const ours = rows(
    `SELECT user_id AS userId, series_id AS seriesId, modality,
            COALESCE(SUM(cost_fen),0) AS fen, COUNT(*) AS calls
       FROM usage_records
      WHERE series_id IS NOT NULL AND status='SUCCESS' AND created_at>=?
      GROUP BY user_id, series_id, modality`,
    [sinceIso],
  );

  // ② 网关账（精确）：读日志 → 令牌名里的 学生/课时 → 课时映射到课包
  const gatewayLogs = config.enabled && config.baseUrl ? await listGatewayLogs({ days }) : [];
  const lessonIds = new Set();
  const parsedLogs = [];
  for (const log of gatewayLogs) {
    const segments = parseTokenSegments(log.token_name);
    const student = segments.find((item) => item.kind === 'student')?.key || '';
    const lesson = segments.find((item) => item.kind === 'lesson')?.key || '';
    if (!student) continue; // 没有学员段就没法归到池子（进 unmapped 汇总）
    if (lesson) lessonIds.add(lesson);
    parsedLogs.push({ student, lesson, quota: Number(log.quota || 0) });
  }
  const seriesOf = new Map();
  if (lessonIds.size) {
    const placeholders = [...lessonIds].map(() => '?').join(',');
    for (const item of rows(`SELECT id, series_id FROM course_lessons WHERE id IN (${placeholders})`, [...lessonIds])) seriesOf.set(item.id, item.series_id);
  }

  const buckets = new Map();
  const ensure = (userId, seriesId) => {
    const key = `${userId}|${seriesId || ''}`;
    if (!buckets.has(key)) buckets.set(key, {
      userId, seriesId: seriesId || null, studentName: '', orgName: '', seriesTitle: '',
      poolTextImageFen: 0, poolOtherFen: 0, poolCalls: 0, gatewayFen: 0, gatewayCalls: 0,
    });
    return buckets.get(key);
  };
  const OVERLAP = new Set(['TEXT', 'IMAGE']);
  for (const item of ours) {
    const bucket = ensure(item.userId, item.seriesId);
    if (OVERLAP.has(String(item.modality || '').toUpperCase())) bucket.poolTextImageFen += Number(item.fen || 0);
    else bucket.poolOtherFen += Number(item.fen || 0);
    bucket.poolCalls += Number(item.calls || 0);
  }
  let unmappedGatewayFen = 0;
  let unmappedGatewayCalls = 0;
  for (const log of parsedLogs) {
    const seriesId = log.lesson ? seriesOf.get(log.lesson) || null : null;
    const fen = Math.round((log.quota / quotaPerUnit) * 100);
    if (!seriesId) { unmappedGatewayFen += fen; unmappedGatewayCalls += 1; continue; }
    const bucket = ensure(log.student, seriesId);
    bucket.gatewayFen += fen; bucket.gatewayCalls += 1;
  }

  // ③ 补名字（学员 / 机构 / 课包）
  const ids = [...buckets.values()];
  if (ids.length) {
    for (const item of buckets.values()) {
      const student = row('SELECT display_name, login, org_id FROM users WHERE id=?', [item.userId]);
      item.studentName = student?.display_name || student?.login || item.userId;
      item.orgName = student?.org_id ? (row('SELECT name FROM organizations WHERE id=?', [student.org_id])?.name || '—') : '—';
      item.seriesTitle = item.seriesId ? (row('SELECT title FROM course_series WHERE id=?', [item.seriesId])?.title || item.seriesId) : '（未归属课包）';
    }
  }

  const toYuan = (fen) => Number((Number(fen || 0) / 100).toFixed(2));
  const list = [...buckets.values()].map((item) => {
    const diffFen = item.poolTextImageFen - item.gatewayFen;
    return {
      ...item,
      poolTextImageYuan: toYuan(item.poolTextImageFen), poolOtherYuan: toYuan(item.poolOtherFen),
      poolTotalYuan: toYuan(item.poolTextImageFen + item.poolOtherFen), gatewayYuan: toYuan(item.gatewayFen),
      diffFen, diffYuan: toYuan(diffFen),
      // 误差率只在网关有数时给：网关没启用/这段时间没有对话图片调用时，给比值会被误读成 bug
      diffPercent: item.gatewayFen > 0 ? Number(((diffFen / item.gatewayFen) * 100).toFixed(1)) : null,
      state: item.gatewayFen > 0 ? 'COMPARABLE' : 'NO_GATEWAY_DATA',
    };
  }).sort((a, b) => Math.abs(b.diffFen) - Math.abs(a.diffFen));

  const sum = (key) => list.reduce((total, item) => total + Number(item[key] || 0), 0);
  return {
    days, quotaPerUnit,
    gatewayEnabled: Boolean(config.enabled && config.baseUrl),
    items: list,
    totals: {
      poolTextImageYuan: toYuan(sum('poolTextImageFen')),
      poolOtherYuan: toYuan(sum('poolOtherFen')),
      poolTotalYuan: toYuan(sum('poolTextImageFen') + sum('poolOtherFen')),
      gatewayYuan: toYuan(sum('gatewayFen')),
      diffFen: sum('poolTextImageFen') - sum('gatewayFen'),
      diffYuan: toYuan(sum('poolTextImageFen') - sum('gatewayFen')),
      unmappedGatewayYuan: toYuan(unmappedGatewayFen),
      unmappedGatewayCalls,
      comparable: list.filter((item) => item.state === 'COMPARABLE').length,
      notComparable: list.filter((item) => item.state === 'NO_GATEWAY_DATA').length,
    },
  };
}

/**
 * 界面用的池子摘要（学生端 / 老师端要看的「还剩多少」）。
 * 挂在已有的负载上（画布项目详情 / VibeCoding 会话详情 / 排课候选），学生与老师不用多打一次接口。
 * 没有课包上下文或没填预算时 `unlimited: true`（口径：留空 = 不限制，只记账）。
 */
export function computePoolSummary({ userId, seriesId, seriesTitle = null } = {}) {
  const status = computePoolStatus({ userId, seriesId });
  const toYuan = (fen) => (fen === null || fen === undefined ? null : Number((Number(fen) / 100).toFixed(2)));
  return {
    seriesId: status.seriesId,
    seriesTitle: seriesTitle || (seriesId ? (row('SELECT title FROM course_series WHERE id=?', [seriesId])?.title || null) : null),
    unlimited: status.unlimited,
    capYuan: toYuan(status.capFen),
    usedYuan: toYuan(status.usedFen),
    remainYuan: toYuan(status.remainFen),
    usagePercent: status.usagePercent,
  };
}

/**
 * 已配置「每学生算力上限」的课包清单。
 * 池子报表只列**有消耗**的池子，于是刚填完预算的人会以为「填了没生效」（用户 2026-09-12 实操时
 * 就是这么问的）。这里把「配了预算、但还没人用」的课包也列出来，让「我填上了」在界面上看得见。
 * ⚠️ 只读我们自己的库（不需要算力网关）—— 没配网关时也要能看到。
 */
export function budgetedSeriesOverview({ limit = 50 } = {}) {
  const toYuan = (fen) => Number((Number(fen || 0) / 100).toFixed(2));
  return rows(
    `SELECT series.id, series.title, series.per_student_budget_fen,
            (SELECT COALESCE(SUM(record.cost_fen),0) FROM usage_records record WHERE record.series_id = series.id) AS used_fen,
            (SELECT COUNT(*) FROM usage_records record WHERE record.series_id = series.id) AS calls
       FROM course_series series
      WHERE series.per_student_budget_fen IS NOT NULL AND series.per_student_budget_fen > 0
      ORDER BY series.updated_at DESC LIMIT ?`,
    [Math.max(1, Math.round(Number(limit) || 50))],
  ).map((item) => ({
    seriesId: item.id, seriesTitle: item.title,
    perStudentYuan: toYuan(item.per_student_budget_fen),
    usedYuan: toYuan(item.used_fen), calls: Number(item.calls || 0),
  }));
}

/**
 * 调用前的池子门禁。返回本次调用要记的 `{ costFen, seriesId }`（调用方拿它去结算，
 * 这样「拦的时候算的钱」与「记的钱」必然一致 —— 同一个取价函数）。
 *
 * 语义（都要守住）：
 *   · 没有课包上下文（例如平台侧代写歌词）→ 不拦、不记账（没有池子可记）；
 *   · 课包没填「每学生算力上限」→ **不拦**（口径：留空 = 不限制，只记账）；
 *   · 池子已用 + 本次预估 > 上限 → 拦，错误码 `COMPUTE_POOL_EXHAUSTED`，文案给学生看；
 *   · `units` 是这次要花的「次数」（文档插画一次生成 3 张就是 3）。
 */
export function assertComputePoolBudget({ userId, seriesId = null, modality, model = '', units = 1 }) {
  const costFen = priceFenFor({ modality, model }) * Math.max(1, Math.round(Number(units) || 1));
  if (!seriesId) return { costFen: 0, seriesId: null, enforced: false };
  const capFen = seriesBudgetFen(seriesId);
  const usedFen = poolUsedFen({ userId, seriesId });
  if (capFen === null) return { costFen, seriesId, enforced: false };
  if (usedFen + costFen > capFen) {
    const yuan = (value) => (Number(value || 0) / 100).toFixed(2);
    throw errors.forbidden(
      `本节课包（课包）的算力额度已用完：上限 ${yuan(capFen)} 元，已用 ${yuan(usedFen)} 元。请联系老师增加额度。`,
      'COMPUTE_POOL_EXHAUSTED',
    );
  }
  return { costFen, seriesId, enforced: true };
}
