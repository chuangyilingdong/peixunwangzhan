// 用户包算力；历史 cost_fen 仅历史售价，课堂平台预算只预警。
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

/**
 * 保存「对外售价观测」配置（模态基础价 perCall + 按模型覆盖 models）。
 *
 * ⚠️ 语义（2026-09-13 观测口径）：这里存的是**对学生的公告售价**，用途只有一个 ——
 *   让 compute_attempts.sale_price_fen / sale_snapshot 记下「按当时的价，这次调用对外值多少」。
 *   它 **不扣学生钱**、**不是上游真实成本**，也 **不是** 课时平台预算基准。
 *   - 学生账本恒 0：usage_records.cost_fen / credits_charged 与这里无关（见 creditUsage.js）。
 *   - 上游成本另有一本账：compute_attempts.upstream_cost_fen（估算/上报，未知不按零算）。
 *   - 改价**不追溯**：已落库的 sale_price_fen / sale_snapshot 保持写入时的值，只有新调用用新价。
 */
export function saveComputePricing(patch = {}) {
  const current = getComputePricing();
  for (const map of [patch.perCall, patch.models]) {
    if (map !== undefined && (!map || typeof map !== 'object' || Array.isArray(map))) throw errors.badRequest('价格必须是对象', 'COMPUTE_PRICE_INVALID');
    for (const value of Object.values(map || {})) if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100000000) throw errors.badRequest('售价必须是0至100000000之间的整数分', 'COMPUTE_PRICE_INVALID');
  }
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

/**
 * 对外售价合计（分）——**机构端 / 学员端显示「消耗」金额的唯一口径**（2026-09-15 定）。
 *
 * 只读 `compute_attempts.sale_price_fen`：逐笔写入时的公告价快照，改价不追溯。
 * **只计成功尝试**（`status='SUCCESS'`）：失败、以及主备切换产生的额外尝试都没有交付东西，
 * 不该让学生/老师看到重复的消耗。这与「平台成本账本里失败尝试天然记 null」是同一个道理。
 * ⚠️ 平台端「用量与成本 → 调用账」的对外售价汇总是**观测口径、按每次尝试各计一行**，两者用途不同，别互相对数。
 *
 * ⚠️ **不要再读 `usage_records.cost_fen`**（2026-09-15 之前机构端各处就是这么读的）。
 *    那一列现在有三种含义混在一起，求和没有意义：
 *      · 现行生成链路写 **0**（平台承担算力成本、不扣学生，见 creditUsage 的注释）；
 *      · VibeCoding 插画那条路径曾把**对外售价**写进去（为了让「每节课花了多少」算上插画）；
 *      · 2026-09-13 之前的历史行是**积分时代**的旧值。
 *    而且没有 compute_attempts 的历史行没有售价证据 —— 按「缺证据不猜」不计入，不是按 0 顶替。
 *
 * 平台自己的**进货成本与毛利**不在这里：那本账在「用量与成本」，读 compute_attempts.upstream_cost_fen。
 */
export function salePriceFenFor({ sessionId = null, studentId = null, orgId = null, since = null } = {}) {
  const conditions = ["status='SUCCESS'"];
  const params = [];
  if (sessionId) { conditions.push('class_session_id=?'); params.push(sessionId); }
  if (studentId) { conditions.push('user_id=?'); params.push(studentId); }
  if (orgId) { conditions.push('org_id=?'); params.push(orgId); }
  if (since) { conditions.push('created_at>=?'); params.push(since); }
  return Number(row(`SELECT COALESCE(SUM(sale_price_fen),0) fen FROM compute_attempts WHERE ${conditions.join(' AND ')}`, params)?.fen || 0);
}

/**
 * 同一口径的 SQL 片段：机构端/学员端的「消耗」直接把它拼进自己的聚合里，
 * 免得每处各写一遍 CASE WHEN 又悄悄写歪（统一走 salePriceFenFor 的定义）。
 * `alias` 传表别名（如 'attempt'）时会带上前缀。
 */
export function salePriceFenSuccessSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `COALESCE(SUM(CASE WHEN ${prefix}status='SUCCESS' THEN ${prefix}sale_price_fen ELSE 0 END),0)`;
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
  // 2026-09-18：这里原来返回「每学生算力上限」的用量（cap/used/remain），但那套池子口径
  // 早已降级成恒 `unlimited` 的兼容桩（`computePoolStatus` 已删）。现在把话说清楚：
  // **没有按课包的学生上限**，不填 = 不限制、只记账；要控成本走「按钱的」那一套（正在收敛）。
  // 前端仍在读 `unlimited` / `capYuan` 这几个键，所以**形状保持不变**、值恒为「不限」。
  void userId;
  return {
    seriesId: seriesId || null,
    seriesTitle: seriesTitle || (seriesId ? (row('SELECT title FROM course_series WHERE id=?', [seriesId])?.title || null) : null),
    unlimited: true,
    capYuan: null,
    usedYuan: null,
    remainYuan: null,
    usagePercent: null,
  };
}

/**
 * 已配置「每学生算力上限」的课包清单。
 * 池子报表只列**有消耗**的池子，于是刚填完预算的人会以为「填了没生效」（用户 2026-09-12 实操时
 * 就是这么问的）。这里把「配了预算、但还没人用」的课包也列出来，让「我填上了」在界面上看得见。
 * ⚠️ 只读我们自己的库（不需要算力网关）—— 没配网关时也要能看到。
 */
// 2026-09-18 删除：seriesBudgetFen / poolUsedFen / computePoolStatus / computePoolReport /
// budgetedSeriesOverview / assertComputePoolBudget —— 全是**兼容桩或空壳**（恒返回 null / unlimited，
// 从不拦截也从不返回有效数据），全仓零外部调用方（只有它们自己的导入行）。
// 「每学生算力上限」这件事历史上被实现了 6 遍、只有课堂次数上限真的会拦人，正在按用户口径收敛成 1 套按钱的。

/** Known upstream amounts are a lower bound whenever any attempt has unknown cost. */
export function classroomBudgetStatus(sessionId) {
  if (!sessionId) return { budgetState: 'UNKNOWN', budgetFen: null, knownCostFen: 0, usedFen: null, unknownCalls: 0 };
  const session = row(`SELECT s.id, s.platform_budget_fen FROM class_sessions s WHERE s.id=?`, [sessionId]);
  const cost = row(`SELECT SUM(CASE WHEN cost_source<>'UNKNOWN' AND upstream_cost_fen IS NOT NULL THEN upstream_cost_fen ELSE 0 END) known,
    SUM(CASE WHEN cost_source='UNKNOWN' OR upstream_cost_fen IS NULL THEN 1 ELSE 0 END) unknown FROM compute_attempts WHERE class_session_id=?`, [sessionId]);
  const historical = Number(row(`SELECT COUNT(*) n FROM usage_records u WHERE class_session_id=? AND NOT EXISTS (SELECT 1 FROM compute_attempts a WHERE a.call_id=u.compute_call_id)`, [sessionId])?.n || 0);
  const budgetFen = session?.platform_budget_fen ?? null;
  const knownCostFen = Number(cost?.known || 0);
  const unknownCalls = Number(cost?.unknown || 0) + historical;
  // 超了多少（分）：只算得出的部分。预算没配、或成本全是未知时不报数字 ——
  // 报一个「0」会让人以为没超，而实际情况是「不知道」（用户口径：要能看出有没有超出、超了多少）。
  const knownComplete = !unknownCalls;
  const overBudgetFen = budgetFen !== null && knownComplete ? Math.max(0, knownCostFen - budgetFen) : null;
  return { budgetFen, knownCostFen, unknownCalls, usedFen: knownComplete ? knownCostFen : null,
    overBudgetFen,
    usagePercent: budgetFen ? Math.round((knownCostFen / budgetFen) * 1000) / 10 : null,
    budgetState: budgetFen !== null && knownCostFen > budgetFen ? 'OVER_BUDGET' : unknownCalls || !session ? 'UNKNOWN' : budgetFen === null ? 'UNCONFIGURED' : 'WITHIN_BUDGET', enforced: false };
}

export function classroomBudgetReport({ limit = 100, orgId = '' } = {}) {
  return rows(`SELECT s.id sessionId,s.org_id orgId,s.lesson_id lessonId,s.series_id seriesId,s.title sessionTitle,
    l.title lessonTitle,o.name orgName,
    (SELECT COUNT(*) FROM session_students p WHERE p.session_id=s.id AND p.status<>'REMOVED') studentCount,
    (SELECT COUNT(*) FROM compute_attempts a WHERE a.class_session_id=s.id) calls
    FROM class_sessions s LEFT JOIN course_lessons l ON l.id=s.lesson_id LEFT JOIN organizations o ON o.id=s.org_id
    WHERE (?='' OR s.org_id=?) ORDER BY s.created_at DESC LIMIT ?`, [orgId, orgId, limit])
    .map(item => ({ ...item, ...classroomBudgetStatus(item.sessionId) }));
}

/** Same lesson aggregated across organizations; each classroom contributes one baseline. */
export function lessonPlatformBudgetOverview() {
  return rows(`SELECT l.id lessonId,l.title lessonTitle,l.platform_budget_fen platformBudgetFen,
    series.title seriesTitle,
    COUNT(s.id) sessionCount,COUNT(DISTINCT s.org_id) orgCount
    FROM course_lessons l
    LEFT JOIN course_series series ON series.id = l.series_id
    LEFT JOIN class_sessions s ON s.lesson_id=l.id
    GROUP BY l.id ORDER BY l.sort`).map(item => {
      const sessions = rows('SELECT id FROM class_sessions WHERE lesson_id=?', [item.lessonId]).map(s => classroomBudgetStatus(s.id));
      const unknownCalls = sessions.reduce((n,s) => n+s.unknownCalls,0);
      const knownCostFen = sessions.reduce((n,s) => n+s.knownCostFen,0);
      const overRows = sessions.filter(s => s.budgetState === 'OVER_BUDGET');
      return { ...item, budgetFen: sessions.some(s => s.budgetFen == null) ? null : sessions.reduce((n,s) => n+s.budgetFen,0),
        knownCostFen, usedFen: unknownCalls ? null : knownCostFen, unknownCalls,
        overBudgetSessions: overRows.length,
        // 这个课时**一共超了多少钱**（各场课堂的超支之和）。有课堂成本未知时给 null ——
        // 「未知」与「没超」必须能分开，否则这条预警会骗人。
        overBudgetFen: unknownCalls ? null : overRows.reduce((n, s) => n + (s.overBudgetFen || 0), 0),
        unknownSessions: sessions.filter(s => s.budgetState==='UNKNOWN').length, enforced: false };
    });
}
