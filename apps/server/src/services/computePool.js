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
 * 调用前的池子门禁。返回本次调用要记的 `{ costFen, seriesId }`，调用方拿它去结算 —— 这样
 * 「拦的时候算的钱」与「记的钱」必然一致（同一套单价）。
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
