// 课包「算力预估」的**只读**读数：把课包上填的预估（分/人）和真实发生的上游成本摆在一起。
//
// 背景（2026-09-18 用户口径）：
//   · 课包的 `estimated_credits_per_person` 以前是**死数据** —— 能填、官网展示、但从来没有和实际消耗
//     对比过；用户明确要求「让它有用」，同时「这个是内部展示用，只有平台自己能看」，所以
//     ① 官网/机构端/学生端都不再下发它（见 lib.js normalizeSeries 的 includeEstimatedCredits），
//     ② 平台端在课包详情里给出「预估 vs 实际」。
//   · 单位统一成**分/人**（与成本账 compute_attempts.upstream_cost_fen 同一口径）。
//
// 归集口径（两条线，都与库里的「课堂 / 课时」结构一致）：
//   · 课时 → 课包：`compute_attempts.lesson_id` 可能为空（老数据 / 无课堂的项目用量），
//     所以用 `COALESCE(attempt.lesson_id, class_sessions.lesson_id)` 兜底找到课时；
//     再退一步，课堂自己带的 `class_sessions.series_id` 也是这个课包的证据。
//   · 金额只算 `status='SUCCESS'` 的尝试；`cost_source='UNKNOWN'` 或金额为空时
//     **只计笔数、不按 0 计入金额**（口径与 services/upstreamCost.js 一致）：
//     已知部分永远是**下界**，所以面板上必须同时显示「另有 N 笔成本未知」。
//
// 不在这里做的事：不做「每节课会用多少次」的用量预测。参考值只做**价目表折算**
// （见 referenceFor），并把它用到的假设逐条写在 note 里。
import { count, lessonCanvasConfig, parseJson, row, rows, arow, arows, acount } from '../lib.js';
import { normalizeModelUnitPrices, normalizeUpstreamUnitPrices, computeContractCost, resolveUnitPrice } from './upstreamCost.js';
import { effectiveCapabilities, modalityChannel } from './modelCapabilities.js';

/** 金额一律按「分」保留 4 位小数：文本单笔成本天然小于 1 分（见 upstreamCost.js 的说明）。 */
function fen(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}

function perPerson(totalFen, students) {
  if (totalFen === null || totalFen === undefined || !students) return null;
  return fen(Number(totalFen) / students);
}

/** 平台当前的 AI 供应商策略（只读）：渠道里的合同单价就是「当前价目表」。 */
async function providerPolicy() {
  return parseJson((await arow('SELECT ai_provider_policy FROM platform_settings WHERE id=1'))?.ai_provider_policy, {});
}

/**
 * 参考值：把**当前价目表**套到该课包课时里**选定的模型**上折算出来的「一个学生上完整门课」的金额。
 *
 * 这就是「单价 × 课时数」：每节课按**每个生成框体各 1 次调用**计，参数取课时里选定的
 * （分辨率 / 时长 / 是否含音频）；平台没指定参数时按模型的默认档位估，并在 boxes 里标 assumed。
 * 明确**不做**用量预测 —— 没有「每节课会调多少次」的依据，编一个精确数字比不给数字更糟。
 *
 * 折算复用生产同一套函数（computeContractCost），所以「参考值」和真实记账的算法不会分叉。
 * 文本模型按 token 计价（分/百万 token），**无法折算成单次金额**：这类框体只列出单价、
 * 不计入 perPersonFen，并在 note 里说明。
 */
async function referenceFor(lessons, policy) {
  const boxes = [];
  const caveats = []; // 折算时做了哪些假设（例如按模型默认时长估）
  let perPersonFen = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;
  let textCalls = 0;
  for (const lesson of lessons) {
    const canvas = await lessonCanvasConfig(lesson.id);
    for (const box of canvas.generationBoxes || []) {
      const modality = String(box.modality || '').toUpperCase();
      const channel = modalityChannel(policy, modality);
      const channelModel = String(channel?.model || '').trim();
      const model = String(box.model || '').trim() || channelModel;
      const entry = { lessonId: lesson.id, lessonTitle: lesson.title, modality, model, modelSource: box.model ? 'LESSON' : (channelModel ? 'CHANNEL_DEFAULT' : 'NONE'), perCallFen: null, assumed: false, reason: '' };
      if (!channel) { entry.reason = 'NO_CHANNEL'; boxes.push(entry); unpricedCalls += 1; continue; }
      if (!model) { entry.reason = 'NO_MODEL'; boxes.push(entry); unpricedCalls += 1; continue; }
      const unitPrices = normalizeUpstreamUnitPrices(channel.upstreamUnitPrices);
      const modelUnitPrices = normalizeModelUnitPrices(channel.modelUnitPrices);
      const resolved = resolveUnitPrice({ unitPrices, modelUnitPrices, model, modality });
      if (!resolved) { entry.reason = 'NO_UNIT_PRICE'; boxes.push(entry); unpricedCalls += 1; continue; }
      const capabilities = effectiveCapabilities(channel, modality, model);
      // 合成「一次调用」的用量证据：参数取框体选定的值，没选定就用模型默认档位（标 assumed）。
      const usage = { modality, inputTokens: null, outputTokens: null, images: 1, seconds: null, resolution: null, audio: null };
      if (modality === 'IMAGE') {
        usage.resolution = String(box.resolution || '').trim() || null;
        if (!usage.resolution) entry.assumed = true;
      } else if (modality === 'VIDEO') {
        const pinned = Number.isInteger(box.durationSeconds) ? box.durationSeconds : null;
        usage.seconds = pinned ?? (Array.isArray(capabilities.durations) && capabilities.durations.length ? capabilities.durations[0] : null);
        if (pinned === null) entry.assumed = true;
        usage.resolution = String(box.resolution || '').trim() || null;
        usage.audio = box.audio === true;
        if (box.audio === null || box.audio === undefined) { entry.assumed = true; caveats.push('视频框体没定「是否含音频」，参考值按不含音频估'); }
      }
      const computed = computeContractCost({ modality, model, unitPrices, modelUnitPrices, usage });
      if (!computed) {
        if (modality === 'TEXT') {
          entry.reason = 'TEXT_PER_TOKEN';
          entry.unitPriceLabel = textUnitPriceLabel(resolved);
          textCalls += 1;
        } else {
          entry.reason = 'UNIT_PRICE_INCOMPLETE';
          unpricedCalls += 1;
        }
        boxes.push(entry);
        continue;
      }
      entry.perCallFen = computed.fen;
      entry.unitPriceLabel = unitPriceLabel(computed.unitPrice, usage);
      perPersonFen += computed.fen;
      pricedCalls += 1;
      boxes.push(entry);
    }
  }
  const lessonCount = lessons.length;
  // 折不出金额的框体：把**原因和数量**写进 note —— 否则读的人只看到「共 0 个可折算框体」，
  // 不知道是没配价、还是没选模型，也就不知道该去哪里补。
  const gapSummary = priceGapSummary(boxes);
  const extra = [...caveats, gapSummary].filter(Boolean);
  const base = `参考值 = 该课包选定模型的合同单价 × 课时数（每节课按每个生成框体各 1 次调用折算，共 ${pricedCalls} 个可折算框体 / ${lessonCount} 个课时）；` +
    '它是按当前价目表算的价、不是用量预测，学生实际调用次数与参数不同就会不一样。';
  return {
    perPersonFen: pricedCalls ? fen(perPersonFen) : null,
    lessonCount,
    boxCount: boxes.length,
    pricedCalls,
    unpricedCalls,
    textCalls,
    note: extra.length ? `${base}（${[...new Set(extra)].join('；')}）` : base,
    boxes,
  };
}

/** 折不出单次金额的框体：按原因归并成一句话（含数量和模态）。 */
function priceGapSummary(boxes) {
  const REASONS = {
    NO_CHANNEL: '该模态还没配渠道',
    NO_MODEL: '框体没选模型、渠道也没默认模型',
    NO_UNIT_PRICE: '价目表里没有这个模型的合同单价',
    UNIT_PRICE_INCOMPLETE: '单价缺项（例如视频只配了按次价、没配每秒价），折不出金额',
    TEXT_PER_TOKEN: '文本按 token 计价（分/百万 token），没有「每节课用多少 token」的依据，不折成单次金额',
  };
  const counted = new Map();
  for (const box of boxes) {
    if (!box.reason) continue;
    const label = `${REASONS[box.reason] || box.reason}（${box.modality}）`;
    counted.set(label, (counted.get(label) || 0) + 1);
  }
  if (!counted.size) return '';
  return `折不出单次金额的框体：${[...counted.entries()].map(([label, n]) => `${label} ${n} 个`).join('、')}`;
}

/** 单次折算命中的单价（写进参考值明细，让人能核对用的是哪一层价）。 */
function unitPriceLabel(unitPrice, usage) {
  if (!unitPrice) return '';
  const parts = [];
  if (unitPrice.perImageFen !== undefined) parts.push(`图片 ${unitPrice.perImageFen} 分/张${unitPrice.matchedResolution ? `（${unitPrice.matchedResolution}）` : ''}`);
  if (unitPrice.perSecondFen !== undefined) parts.push(`视频 ${unitPrice.perSecondFen} 分/秒 × ${usage.seconds ?? '?'} 秒${unitPrice.audioExtraPerSecondFen ? ` + 含音频 ${unitPrice.audioExtraPerSecondFen} 分/秒` : ''}`);
  if (unitPrice.perCallFen !== undefined) parts.push(`音乐 ${unitPrice.perCallFen} 分/次`);
  return parts.join('；');
}

/** 文本模型只报单价（分/百万 token），不折成单次金额。 */
function textUnitPriceLabel(resolved) {
  const price = resolved?.price || {};
  const parts = [];
  if (price.inputFenPer1MTokens !== undefined) parts.push(`输入 ${price.inputFenPer1MTokens} 分/百万 token`);
  if (price.outputFenPer1MTokens !== undefined) parts.push(`输出 ${price.outputFenPer1MTokens} 分/百万 token`);
  return parts.join(' · ');
}

/**
 * 该课包下真实发生的上游成本（按课时拆分），只认 `status='SUCCESS'` 的尝试。
 * 未知成本只计笔数，金额一侧永远只报**已知部分**（下界）。
 */
async function actualFor(seriesId) {
  const attemptRows = await arows(
    `SELECT COALESCE(lesson.id, '') lesson_id,
            COALESCE(lesson.title, session.title, '未关联课时') lesson_title,
            COUNT(*) attempts,
            SUM(CASE WHEN attempt.status='SUCCESS' THEN 1 ELSE 0 END) success_attempts,
            SUM(CASE WHEN attempt.status='SUCCESS' AND (attempt.cost_source='UNKNOWN' OR attempt.upstream_cost_fen IS NULL) THEN 1 ELSE 0 END) unknown_calls,
            SUM(CASE WHEN attempt.status='SUCCESS' AND attempt.cost_source<>'UNKNOWN' AND attempt.upstream_cost_fen IS NOT NULL THEN attempt.upstream_cost_fen ELSE 0 END) known_fen,
            COUNT(DISTINCT CASE WHEN attempt.status='SUCCESS' THEN attempt.user_id END) compute_students
       FROM compute_attempts attempt
       LEFT JOIN class_sessions session ON session.id = attempt.class_session_id
       LEFT JOIN course_lessons lesson ON lesson.id = COALESCE(attempt.lesson_id, session.lesson_id)
      WHERE COALESCE(lesson.series_id, session.series_id) = ?
      GROUP BY COALESCE(lesson.id, ''), COALESCE(lesson.title, session.title, '未关联课时')`,
    [seriesId],
  );
  // 老课堂的用量没有 compute_attempts 那一行（P90 之前的记录）：金额同样「不知道」，
  // 只计笔数、不按 0 算 —— 与 computePool.classroomBudgetStatus 的历史用量口径一致。
  const legacyRows = (await arows(
    `SELECT COALESCE(lesson.id, '') lesson_id, COALESCE(lesson.title, session.title, '未关联课时') lesson_title, COUNT(*) legacy_calls
       FROM usage_records usage
       LEFT JOIN class_sessions session ON session.id = usage.class_session_id
       LEFT JOIN course_lessons lesson ON lesson.id = session.lesson_id
      WHERE COALESCE(lesson.series_id, session.series_id, usage.series_id) = ?
        AND usage.status = 'SUCCESS'
        AND NOT EXISTS (SELECT 1 FROM compute_attempts attempt WHERE attempt.call_id = usage.compute_call_id)
      GROUP BY COALESCE(lesson.id, ''), COALESCE(lesson.title, session.title, '未关联课时')`,
    [seriesId],
  )).filter((item) => Number(item.legacy_calls || 0) > 0);

  const byLesson = new Map();
  const bucket = (lessonId) => {
    if (!byLesson.has(lessonId)) byLesson.set(lessonId, { lessonId, lessonTitle: '', attemptCount: 0, successAttemptCount: 0, unknownCostCalls: 0, uncostedLegacyCalls: 0, knownCostFen: 0, computeStudents: 0 });
    return byLesson.get(lessonId);
  };
  let knownTotalFen = 0;
  let attemptCount = 0;
  let successAttemptCount = 0;
  let unknownCostAttempts = 0;
  for (const item of attemptRows) {
    const entry = bucket(item.lesson_id || '');
    entry.lessonTitle = item.lesson_title || entry.lessonTitle;
    entry.attemptCount += Number(item.attempts || 0);
    entry.successAttemptCount += Number(item.success_attempts || 0);
    entry.unknownCostCalls += Number(item.unknown_calls || 0);
    entry.knownCostFen = fen(entry.knownCostFen + Number(item.known_fen || 0));
    entry.computeStudents += Number(item.compute_students || 0);
    attemptCount += Number(item.attempts || 0);
    successAttemptCount += Number(item.success_attempts || 0);
    unknownCostAttempts += Number(item.unknown_calls || 0);
    knownTotalFen += Number(item.known_fen || 0);
  }
  let uncostedLegacyCalls = 0;
  for (const item of legacyRows) {
    const entry = bucket(item.lesson_id || '');
    entry.lessonTitle = item.lesson_title || entry.lessonTitle;
    entry.uncostedLegacyCalls += Number(item.legacy_calls || 0);
    uncostedLegacyCalls += Number(item.legacy_calls || 0);
  }
  return { knownTotalFen: fen(knownTotalFen), attemptCount, successAttemptCount, unknownCostAttempts, uncostedLegacyCalls, lessons: [...byLesson.values()] };
}

/** 「上过课的学生数」：以课堂名单为准（session_students），没有名单时才退回真实用过算力的人。 */
async function cohortFor(seriesId) {
  const roster = Number(await acount(
    `SELECT COUNT(DISTINCT participant.student_id) n
       FROM session_students participant
       LEFT JOIN class_sessions session ON session.id = participant.session_id
       LEFT JOIN course_lessons lesson ON lesson.id = COALESCE(session.lesson_id, participant.lesson_id)
      WHERE participant.status <> 'REMOVED'
        AND COALESCE(lesson.series_id, session.series_id, participant.series_id) = ?`,
    [seriesId],
  ) || 0);
  const computeStudents = Number(await acount(
    `SELECT COUNT(DISTINCT attempt.user_id) n
       FROM compute_attempts attempt
       LEFT JOIN class_sessions session ON session.id = attempt.class_session_id
       LEFT JOIN course_lessons lesson ON lesson.id = COALESCE(attempt.lesson_id, session.lesson_id)
      WHERE attempt.status='SUCCESS' AND attempt.user_id IS NOT NULL
        AND COALESCE(lesson.series_id, session.series_id) = ?`,
    [seriesId],
  ) || 0);
  if (roster > 0) return { studentCount: roster, studentCountSource: 'SESSION_ROSTER', rosterStudentCount: roster, computeStudentCount: computeStudents };
  if (computeStudents > 0) return { studentCount: computeStudents, studentCountSource: 'COMPUTE_USERS', rosterStudentCount: roster, computeStudentCount: computeStudents };
  return { studentCount: 0, studentCountSource: 'NONE', rosterStudentCount: roster, computeStudentCount: computeStudents };
}

/**
 * 课包「算力预估 vs 实际」读数（只读）。
 * 未知成本只计笔数：`actualTotalFen` / `actualPerPersonFen` 在成本没算全时是 `null`，
 * 已知部分另外给在 `actualKnownTotalFen` / `actualKnownPerPersonFen`（**下界**）里。
 */
export async function courseComputeEstimate(seriesId) {
  const series = await arow('SELECT id,title,estimated_credits_per_person FROM course_series WHERE id=?', [seriesId]);
  if (!series) return null;
  const lessons = await arows('SELECT id,title,sort FROM course_lessons WHERE series_id=? ORDER BY sort, created_at', [seriesId]);
  const estimatedPerPersonFen = Math.max(0, Math.round(Number(series.estimated_credits_per_person || 0)));
  const actual = await actualFor(seriesId);
  const cohort = await cohortFor(seriesId);
  const unknownCostCalls = actual.unknownCostAttempts + actual.uncostedLegacyCalls;
  const costComplete = unknownCostCalls === 0;
  const actualKnownTotalFen = actual.knownTotalFen;
  const actualTotalFen = costComplete ? actualKnownTotalFen : null;
  const estimatedTotalFen = cohort.studentCount && estimatedPerPersonFen ? estimatedPerPersonFen * cohort.studentCount : null;
  const actualKnownPerPersonFen = perPerson(actualKnownTotalFen, cohort.studentCount);
  // 超预估的判断用**已知下界**：已经超过就是真的超了（还有未知只会更多）。
  // 反过来（已知没超）不能断言没超 —— 面板靠 costComplete 说明这一点。
  const overEstimate = Boolean(estimatedPerPersonFen && cohort.studentCount && actualKnownPerPersonFen !== null && actualKnownPerPersonFen > estimatedPerPersonFen);
  const reference = await referenceFor(lessons, await providerPolicy());
  return {
    seriesId: series.id,
    seriesTitle: series.title,
    estimatedPerPersonFen,
    estimateConfigured: estimatedPerPersonFen > 0,
    ...cohort,
    attemptCount: actual.attemptCount,
    successAttemptCount: actual.successAttemptCount,
    failedAttemptCount: actual.attemptCount - actual.successAttemptCount,
    actualKnownTotalFen,
    actualTotalFen,
    actualKnownPerPersonFen,
    actualPerPersonFen: costComplete ? actualKnownPerPersonFen : null,
    unknownCostCalls,
    unknownCostAttempts: actual.unknownCostAttempts,
    uncostedLegacyCalls: actual.uncostedLegacyCalls,
    costComplete,
    estimatedTotalFen,
    overEstimate,
    overEstimateFen: overEstimate ? fen(actualKnownTotalFen - estimatedTotalFen) : 0,
    lessons: actual.lessons.map((item) => ({ ...item, lessonTitle: item.lessonTitle || '未关联课时' })),
    reference,
  };
}
