// 平台管理端「overview」域路由：从 adminOrg.js 拆出，行为不变。
import { clearGatewayRouteCache, createGatewayToken, gatewayUsageOverview, getComputeGatewayConfig, listGatewayChannels, listGatewayTokens, saveComputeGatewayConfig, testComputeGateway } from '../../services/computeGateway.js';
import { classroomBudgetReport, lessonPlatformBudgetOverview, computePoolReconciliation, getComputePricing, saveComputePricing } from '../../services/computePool.js';
import {
  audit, count, errors, id, json, normalizeOrg, normalizePackage,
  normalizeSeries, normalizeSession, normalizeUser, normalizeWork, normalizeWorkReport, lessonCanvasConfig, nonEmptyString, nowIso, parseJson,
  assignmentActiveSql, PLATFORM_ADMIN_PERMISSIONS, platformPermissionForPathname, q, requirePlatformPermission, requireRole, row, rows, transaction, verifyPassword,
} from '../../lib.js';
import { hashPassword } from '@platform/database';
import { randomUUID } from 'node:crypto';
import { scheduleReminder } from '../communication.js';
import { assertKnownState, assertTransition } from '../../services/domainState.js';
import { getAiProviderPolicy } from '../billingConfig.js';
import { getProviderApiKey } from '../../services/providerSecret.js';
import { AI_PROVIDER_API_KEY } from '../../config.js';
import { resolveUnitPrice } from '../../services/upstreamCost.js';
import { MEASURED_PRICE_RULES, measuredUnitPrices } from '../../services/measuredUnitPrices.js';
import { effectiveCapabilities, normalizeAspectRatio } from '../../services/modelCapabilities.js';
import { disableMfa, enableMfa, mfaSummary, regenerateRecoveryCodes, startMfaSetup } from '../../services/mfa.js';
import { normalizeSubmission } from '../vibecoding.js';
import {
  ENROLLMENT_STATUSES,
  ORG_MEMBER_ROLES,
  ORG_TEACHER_PERMISSIONS,
  PAYMENT_STATUSES,
  accessibleLesson,
  accessibleSeries,
  annotationRows,
  appendEnrollmentEvent,
  assertAnnotationNode,
  assertEnrollmentSeat,
  assertNotLastOrgAdmin,
  assertSelfPassword,
  auditListQuery,
  auditQuery,
  auditRow,
  buildOrganizationDetail,
  buildStudentDataExport,
  bumpSeriesVersion,
  contactPayload,
  createMember,
  csvDocument,
  csvFileName,
  enrollmentDate,
  enrollmentRow,
  ensureOrgBilling,
  escapeCsv,
  expireDueEnrollments,
  hasAnyPlatformPermission,
  hasPermission,
  importItems,
  integer,
  lastSuperAdminGuard,
  normalizeCanvasTemplateSnapshot,
  normalizeClassroomConfig,
  normalizeDeliveryMode,
  normalizeEnrollment,
  normalizeWorkPublishRequest,
  occupiedStudentSeats,
  orgAdminRows,
  orgContractMeta,
  orgId,
  orgMemberRow,
  orgUser,
  organizationFilters,
  organizationRow,
  packageSnapshot,
  packageWithSeatUsage,
  platformAdminPermissions,
  platformIssuerName,
  platformUserFilters,
  platformUserRow,
  platformWorkFilters,
  previewImport,
  replaceLessonCanvasConfig,
  replaceLessonTeachingMaterials,
  reportResolution,
  setStudentEnrollmentAccess,
  softDeleteStudent,
  userLoginMeta,
  validateImportItem,
  validateMemberPermissions,
  validateMemberPhone,
  validateSeriesForPublishing,
  validateTeacher,
  workInReviewScope,
  workReportInReviewScope,
  workReportRows,
} from './helpers.js';

/* ── 实测单价（P92）：上游逐笔实扣 → 我们真实的单价，并与合同单价对照 ──────────────────────
 *
 * 用户口径（2026-09-18）：「每个模型我们能知道我们的成本价格」。上游没有价目表 API 可拉
 * （能拉的只有模型清单），但**逐笔实扣我们已经在收**（compute_attempts.upstream_cost_fen，
 * cost_source='REPORTED'），所以成本价以「实扣反推的实测单价」为主，价目表里的合同单价仍由人填、可覆盖。
 *
 * 数据源与算法在 services/measuredUnitPrices.js（那里只读账本，不解析配置、不写任何东西）。
 * 这里只做两件事，都是**只读**的：
 *   ① 把实测单价与该 (渠道, 模型, 模态) **当前的合同价**并排（用现成的 getAiProviderPolicy +
 *      resolveUnitPrice 取值，不自己解析 ai_provider_policy）；
 *   ② 算出偏差 deviationPercent，并给出「采纳为成本价」要写的那几个字段（suggestedUnitPrices）——
 *      真正的写入由人在价目表上点按钮触发，走 PUT admin/billing-config/ai-provider（本端点永不写配置）。
 *
 * 偏差拿什么和实测比：**同一批样本、同一用量构成**下的合同价折算值。
 *   TEXT 按实际的输入/输出 token 混比混价（合同价 × 本次混比），IMAGE 用每张价，
 *   VIDEO 用每秒价（含音频样本再加音频加价），MUSIC 用每次价 —— 这样两边是同一个单位、可直接相减。
 */
function fenOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function measuredContractComparableUnitPrice({ modality, prices, units }) {
  if (!prices) return null;
  if (modality === 'TEXT') {
    const inputFen = fenOrNull(prices.inputFenPer1MTokens);
    const outputFen = fenOrNull(prices.outputFenPer1MTokens);
    if (!(units.tokens > 0)) return null;
    if (units.inputTokens > 0 && inputFen === null) return null;
    if (units.outputTokens > 0 && outputFen === null) return null;
    // 分/百万 token：(输入 token × 输入价 + 输出 token × 输出价) ÷ 总 token
    return Math.round(((units.inputTokens * (inputFen ?? 0) + units.outputTokens * (outputFen ?? 0)) / units.tokens) * 100) / 100;
  }
  if (modality === 'IMAGE') return fenOrNull(prices.perImageFen);
  if (modality === 'VIDEO') {
    const perSecondFen = fenOrNull(prices.perSecondFen);
    if (perSecondFen === null) return null;
    if (units.audioSeconds > 0) {
      const audioExtraFen = fenOrNull(prices.audioExtraPerSecondFen);
      if (audioExtraFen === null) return null;
      return Math.round(((units.seconds * perSecondFen + units.audioSeconds * audioExtraFen) / units.seconds) * 100) / 100;
    }
    return perSecondFen;
  }
  if (modality === 'MUSIC') return fenOrNull(prices.perCallFen);
  return null;
}

/** 「采纳为成本价」要写进模型级合同单价的字段（**只算不写**，写入由人点按钮触发）。 */
function measuredSuggestedUnitPrices({ item, contractPrices, contractComparable }) {
  const measured = item.measuredUnitPrice;
  if (measured === null || measured === undefined) return { prices: null, note: null };
  if (item.modality === 'IMAGE') return { prices: { perImageFen: measured }, note: null };
  if (item.modality === 'MUSIC') return { prices: { perCallFen: measured }, note: '音乐按次计价（契约里 MUSIC 的主价是每次价）。' };
  if (item.modality === 'VIDEO') {
    const audioExtraFen = fenOrNull(contractPrices?.audioExtraPerSecondFen);
    if (item.units.audioSamples > 0 && audioExtraFen !== null && item.units.seconds > 0) {
      // 含音频的样本里，音频加价那部分要从实扣里先扣掉，剩下的才是「基础每秒价」——
      // 否则会把音频加价重复算进每秒价。已配的音频加价原样保留，本函数不动它。
      const base = (item.totalCostFen - audioExtraFen * item.units.audioSeconds) / item.units.seconds;
      if (!(base > 0)) return { prices: null, note: '实扣除掉音频加价后不为正，无法反推每秒价（检查音频加价是否填错）。' };
      return { prices: { perSecondFen: Math.round(base) }, note: '含音频样本已按当前音频加价扣除，写入的是基础每秒价。' };
    }
    return { prices: { perSecondFen: measured }, note: item.units.audioSamples > 0 ? '样本含音频但没配音频加价，写入的是含音频的均价。' : null };
  }
  if (item.modality === 'TEXT') {
    // 文本有两个 token 单价，实扣总额**拆不开**输入/输出。折中办法（并如实标注）：
    // 保持合同价里输入:输出的比例，等比缩放到实测总额 —— 总额对了，比例仍是人填的那个。
    const inputFen = fenOrNull(contractPrices?.inputFenPer1MTokens);
    const outputFen = fenOrNull(contractPrices?.outputFenPer1MTokens);
    if (inputFen === null || outputFen === null || !(contractComparable > 0)) {
      return { prices: null, note: '文本有输入/输出两个 token 单价，单靠实扣总额拆不开。请先按上游价目表填一次输入/输出价，之后就能用实测总额等比校正。' };
    }
    const scale = measured / contractComparable;
    return {
      prices: { inputFenPer1MTokens: Math.round(inputFen * scale), outputFenPer1MTokens: Math.round(outputFen * scale) },
      note: '文本按实测总额等比校正（输入:输出 比例保持合同价里的比例不变）。',
    };
  }
  return { prices: null, note: null };
}

/** 把 service 的实测结果与该渠道当前合同价拼成端点返回体（只读）。 */
function measuredUnitPriceItems(measured, policy) {
  const channels = new Map((policy?.channels || []).map((channel) => [channel.id, channel]));
  return measured.items.map((item) => {
    const channel = channels.get(item.channelId) || null;
    const resolved = channel
      ? resolveUnitPrice({ unitPrices: channel.upstreamUnitPrices || null, modelUnitPrices: channel.modelUnitPrices || null, model: item.model, modality: item.modality })
      : null;
    const contractPrices = resolved?.price || null;
    const comparable = contractPrices ? measuredContractComparableUnitPrice({ modality: item.modality, prices: contractPrices, units: item.units }) : null;
    const deviationPercent = item.measuredUnitPrice !== null && comparable !== null && comparable > 0
      ? Math.round(((item.measuredUnitPrice - comparable) / comparable) * 1000) / 10
      : null;
    const suggested = channel ? measuredSuggestedUnitPrices({ item, contractPrices, contractComparable: comparable }) : { prices: null, note: '这条渠道不在当前配置里，采纳会写到无主配置上，已禁用。' };
    return {
      ...item,
      channelName: channel?.name || null,
      contract: {
        configured: Boolean(contractPrices),
        channelConfigured: Boolean(channel),
        level: resolved ? (resolved.modelPrice ? 'MODEL' : 'MODALITY') : null,
        prices: contractPrices,
        comparableUnitPrice: comparable,
      },
      deviationPercent,
      suggestedUnitPrices: suggested.prices,
      suggestNote: suggested.note,
    };
  });
}

/* ── 上游账户余额探针（P113，2026-09-18 用户口径「学生消耗能显示实时实际价格消耗吗」）─────────────
 *
 * 用户问的是两件事，答案是「一半已经有、一半这次补上」：
 *   ① **逐笔实扣**（每个学生每节课真花了多少钱）——**已经在收**：上游异步任务终态响应里带
 *      `usage:{amount,currency}`，我们解析后落 `compute_attempts.upstream_cost_fen`（cost_source='REPORTED'），
 *      平台端「调用账」已能按学生 / 课包 / 课时看。这部分与下面的探针无关，本端点一个字都不改它。
 *   ② **上游账户余额**（我们这把 key 在供应商那边还剩多少钱）——上游有这个接口，我们此前没接。
 *      用户口径：「加一下，只有平台内部可以看」。
 *
 * 上游接口（文档 https://api.seedance.nz/docs/，已核实）：
 *   GET {base}/api/usage/wallet/，鉴权 `Authorization: Bearer sk-…`（就是渠道里存的那把 key）。
 *   `data` 里是 { object:'wallet_balance', quota, used_quota, total_available, amount, used_amount,
 *                display_type, username, group }，`display_type` 是 CNY / USD / TOKENS。
 *
 * 三条硬边界（都在本文件里落实，别在别处再实现一遍）：
 *   · **只读**：本端点不写任何配置、不落库、不改账本，纯粹是「把渠道的 key 拿去上游问一句」。
 *   · **key 绝不外泄**：响应体只取下面那 8 个字段 + 我们自己的错误文案；**不带** Authorization 头、
 *     **不带** key、**不透传**上游原始响应（上游错误文案里出现 key 片段也要擦掉，见 scrubUpstreamSecret）。
 *   · **平台内部专用**：与同文件其它 billing 端点同一道门（SUPER_ADMIN + ADMIN_BILLING），
 *     机构管理员 / 教师 / 学生一律 403；这块 UI 也只放在平台端「AI 能力与价格」页。
 */
const UPSTREAM_WALLET_PATH = '/api/usage/wallet/';
// 8~10 秒：给上游留够时间，又不至于让平台端点了刷新之后一直转圈。
// 每个渠道**各自**吃这一个超时（并发发，见下方 Promise.all）——串行的话 30 条渠道最坏 4 分半，
// 页面会以为卡死，运维也会以为是我们挂了。
const UPSTREAM_WALLET_TIMEOUT_MS = 9000;

/**
 * 从渠道的**调用地址**推出上游**账户接口**的基地址（base）。不硬编码任何域名 —— 我们有多渠道。
 *
 * 为什么要推、不能直接用：渠道里存的 `endpoint` 是**生成接口**的地址，形如
 *   · `https://api.seedance.nz/v1`   （带末尾版本段，常态）
 *   · `https://api.seedance.nz/v1/`  （多一条斜杠，等价）
 *   · `https://api.seedance.nz`      （已经是站点根）
 *   · `https://host:8443/openai/v1/chat/completions`（配到头了，还带路径前缀）
 * 而上游的账户接口路径是**挂在站点根上**的 `/api/usage/wallet/`（文档给的 base 就是站点根），
 * 直接拼 `endpoint + /api/usage/wallet/` 会拼出 `/v1/api/usage/wallet/` 这种不存在的地址。
 *
 * 规则（两步，都是纯形状判定，与具体厂商无关）：
 *   ① 取 URL 的 origin（协议 + 主机 + 端口）—— 这一步就覆盖了绝大多数渠道；
 *   ② 若路径里还剩**非资源、非版本**的前缀段（例如 `/openai`、`/anthropic` 这类子路径部署），
 *      保留它接在 origin 后面；从尾部**逐段丢弃**的是：
 *        · 版本段：`v1` / `v2` / `v1beta` / `v1.5` / `alpha1` 这类；
 *        · 生成接口的落点段：`chat` / `completions` / `responses` / `messages` / `models` /
 *          `images` / `generations` / `videos` / `music` / `audio` / `speech` / `embeddings` 等。
 *      只丢**尾部**的段，中间的前缀段留着 —— 否则 `https://host/openai/v1` 会被推成站点根，
 *      把「子路径部署的网关」推错（这类渠道的账户接口在 `/openai/api/usage/wallet/`）。
 *   推不出来（空值 / 非法 URL / 非 http(s)）就返回 ''，由调用方把该渠道标成 `ok:false` ——
 *   **不猜、也不打到别的域名上去**。
 */
const UPSTREAM_BASE_TAIL_SEGMENT = /^(?:v\d+(?:[.\-]\d+)*(?:beta\d*|alpha\d*|preview\d*|rc\d*)?|beta\d*|alpha\d*|preview\d*|rc\d*|chat|completions|responses|messages|models|images|generations|videos|music|audio|speech|embeddings|edit|rerank)$/i;
export function upstreamWalletBase(endpoint) {
  const raw = String(endpoint || '').trim();
  if (!raw) return '';
  let url = null;
  try { url = new URL(raw); } catch { return ''; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  // origin 天然丢掉 URL 里的 user:pass@（真有的话也不能进响应体）
  const segments = url.pathname.split('/').filter(Boolean);
  while (segments.length && UPSTREAM_BASE_TAIL_SEGMENT.test(segments[segments.length - 1])) segments.pop();
  return url.origin + (segments.length ? `/${segments.join('/')}` : '');
}

/** 该渠道探余额要用哪把 key —— 与生成链路**同一套回退顺序**（见 services/generationProvider.js）：
 *  渠道自己的 key → default 那把（老的单供应商配置）→ 全局 env。不另造一套取 key 规则，
 *  否则会出现「能生成、但探不到余额」这种自相矛盾的状态。 */
function upstreamWalletKey(channelId) {
  return getProviderApiKey(String(channelId || 'default')) || getProviderApiKey() || AI_PROVIDER_API_KEY;
}

/** 擦掉任何可能是密钥的片段：先精确替换这把 key，再兜掉 `sk-…` 形状的串。
 *  上游的报错文案有时会把收到的 key 前缀回显出来 —— 那种话**不能**原样带回前端。 */
function scrubUpstreamSecret(text, secret) {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('[已隐藏]');
  return out.replace(/\bsk-[A-Za-z0-9_-]{4,}/g, '[已隐藏]').slice(0, 200);
}

/** 上游返回里的文本字段（username / group）：擦洗后再截断；上游没给就是 null（前端不显示）。 */
function upstreamText(value, secret) {
  if (value === null || value === undefined) return null;
  const text = scrubUpstreamSecret(value, secret).slice(0, 80);
  return text || null;
}

/** 上游返回里的数值：是有限数字就给数字，别的（字符串数字也收）给 null —— 前端据此不显示。 */
function upstreamNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 探一个渠道的账户余额。**永不抛错**：任何失败都变成 `{ ok:false, error }`，
 * 一条渠道挂掉不能让整页 500（用户口径：绝不让整个页面炸）。
 * 返回体里**只有**文档里的那 8 个字段 + 我们自己的字段，上游原始响应整体不透传。
 */
async function probeUpstreamWallet(channel) {
  const base = { channelId: channel.id, name: channel.name || channel.id };
  const rawEndpoint = String(channel.endpoint || '').trim();
  if (!rawEndpoint) return { ...base, endpointBase: '', skipped: true, reason: 'NO_ENDPOINT', ok: false, error: '该渠道没有配调用地址，已跳过（没有向上游发请求）' };
  const endpointBase = upstreamWalletBase(rawEndpoint);
  if (!endpointBase) return { ...base, endpointBase: '', skipped: true, reason: 'ENDPOINT_UNUSABLE', ok: false, error: '调用地址不是可用的 http(s) 地址，推不出账户接口，已跳过' };
  const apiKey = upstreamWalletKey(channel.id);
  // 没配 key 的渠道：照列（否则运维看不到「这条渠道为什么不在列表里」），标 skipped + 原因，
  // 且**绝不发请求** —— 没 key 可带，发过去只会换来一个 401，白暴露一次探测。
  if (!apiKey) return { ...base, endpointBase, skipped: true, reason: 'NO_API_KEY', ok: false, error: '该渠道未配置 API Key，已跳过（没有向上游发请求）' };

  const url = endpointBase + UPSTREAM_WALLET_PATH;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_WALLET_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok) {
      const upstreamMessage = scrubUpstreamSecret(payload?.message || payload?.error?.message || '', apiKey);
      const error = response.status === 401 || response.status === 403
        ? `上游拒绝这把 API Key（HTTP ${response.status}），请在 ① 里重新填写并保存`
        : response.status === 404
          ? `上游这个地址下没有账户接口（HTTP 404：${UPSTREAM_WALLET_PATH}），确认调用地址是否指到站点根`
          : `上游返回 HTTP ${response.status}${upstreamMessage ? `：${upstreamMessage}` : ''}`;
      return { ...base, endpointBase, ok: false, error };
    }
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    if (!data || typeof data !== 'object') return { ...base, endpointBase, ok: false, error: '上游返回的不是 JSON，账户接口可能不存在' };
    const displayType = data.display_type === null || data.display_type === undefined ? null : String(data.display_type).slice(0, 20);
    const amount = upstreamNumber(data.amount);
    if (displayType === null && amount === null) return { ...base, endpointBase, ok: false, error: '上游响应里没有余额字段（display_type 与 amount 都没有）' };
    return {
      ...base, endpointBase, ok: true, error: null,
      // display_type 原样带出（CNY / USD / TOKENS，将来上游加币种也不用改我们），
      // currencyLike 只是给前端一个「要不要套金额阈值」的判据：认得出的币种才算钱。
      displayType, currencyLike: displayType && /^[A-Z]{3}$/.test(displayType) ? displayType : null,
      amount, usedAmount: upstreamNumber(data.used_amount),
      quota: upstreamNumber(data.quota), usedQuota: upstreamNumber(data.used_quota),
      totalAvailable: upstreamNumber(data.total_available),
      // username / group 也过一遍擦洗：上游若把收到的 key 回显在某个账号字段里，照样进不来前端。
      username: upstreamText(data.username, apiKey),
      group: upstreamText(data.group, apiKey),
      walletPath: UPSTREAM_WALLET_PATH,
    };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    const cause = scrubUpstreamSecret(error?.cause?.code || error?.message || '未知原因', apiKey);
    return { ...base, endpointBase, ok: false, error: aborted ? `上游 ${UPSTREAM_WALLET_TIMEOUT_MS} 毫秒内没有响应（先确认平台能不能访问这个地址）` : `连不上上游（${cause}）` };
  } finally {
    clearTimeout(timer);
  }
}

export async function handleOverview(ctx, part, method) {
  if (part === '/billing/filter-options' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const orgId = String(ctx.search.get('orgId') || '').trim();
    return {
      students: rows("SELECT id,display_name name,login FROM users WHERE role='STUDENT' AND deleted_at IS NULL AND (?='' OR org_id=?) ORDER BY display_name,login", [orgId, orgId]),
      series: rows('SELECT id,title name FROM course_series ORDER BY title'),
      lessons: rows('SELECT id,title name,series_id seriesId FROM course_lessons ORDER BY title'),
    };
  }
  if (part === '/compute-attempts' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '每页数量', { min: 1, max: 100, fallback: 20 });
    const conditions = ['attempt.created_at>=?'];
    const params = [new Date(Date.now() - days * 86400000).toISOString()];
    for (const [key, column] of [
      ['orgId','org_id'],['userId','user_id'],['status','status'],['callId','call_id'],['clientRequestId','client_request_id'],
      ['responseRequestId','response_request_id'],['responsePayloadId','response_payload_id'],['taskId','task_id'],['usageId','usage_id'],
      ['gatewayLogId','gateway_log_id'],['channelId','channel_id'],['actualChannelId','actual_channel_id'],['provider','provider'],
      ['providerAccountRef','provider_account_ref'],['model','model'],['routedVia','routed_via'],
    ]) if (ctx.search.get(key)) { conditions.push(`attempt.${column}=?`); params.push(ctx.search.get(key)); }
    const evidenceSql = `(attempt.response_request_id IS NOT NULL OR attempt.response_payload_id IS NOT NULL OR attempt.task_id IS NOT NULL OR attempt.usage_id IS NOT NULL OR attempt.gateway_log_id IS NOT NULL)`;
    const exactEvidenceSql = `(attempt.gateway_log_id IS NOT NULL OR attempt.response_request_id IS NOT NULL OR attempt.response_payload_id IS NOT NULL OR attempt.task_id IS NOT NULL)`;
    const evidenceMatch = String(ctx.search.get('evidenceMatch') || '').trim().toUpperCase();
    if (evidenceMatch === 'MATCHED') conditions.push(exactEvidenceSql);
    else if (evidenceMatch === 'PARTIAL') conditions.push(`${evidenceSql} AND NOT ${exactEvidenceSql}`);
    else if (evidenceMatch === 'UNMATCHED') conditions.push(`NOT ${evidenceSql}`);
    else if (evidenceMatch) throw errors.badRequest('证据匹配状态无效', 'INVALID_EVIDENCE_MATCH');
    const where = conditions.join(' AND ');
    const total = Number(row(`SELECT COUNT(*) n FROM compute_attempts attempt WHERE ${where}`, params)?.n || 0);
    const offset = (page - 1) * limit;
    const items = rows(`SELECT attempt.*,org.name org_name,student.display_name student_name FROM compute_attempts attempt LEFT JOIN organizations org ON org.id=attempt.org_id LEFT JOIN users student ON student.id=attempt.user_id WHERE ${where} ORDER BY attempt.created_at DESC,attempt.attempt DESC LIMIT ? OFFSET ?`, [...params, limit, offset]).map((item) => {
      const hasExact = Boolean(item.gateway_log_id || item.response_request_id || item.response_payload_id || item.task_id);
      const hasAny = hasExact || Boolean(item.usage_id);
      return {
        ...item,
        callId: item.call_id, clientRequestId: item.client_request_id, responseRequestId: item.response_request_id,
        responsePayloadId: item.response_payload_id, taskId: item.task_id, usageId: item.usage_id, gatewayLogId: item.gateway_log_id,
        channelId: item.channel_id, actualChannelId: item.actual_channel_id, providerAccountRef: item.provider_account_ref,
        costRuleSnapshot: parseJson(item.cost_rule_snapshot, null), evidenceMatch: hasExact ? 'MATCHED' : hasAny ? 'PARTIAL' : 'UNMATCHED',
      };
    });
    return {
      items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)),
      summary: row(`SELECT COUNT(*) calls,SUM(CASE WHEN cost_source='ESTIMATED' THEN upstream_cost_fen ELSE 0 END) estimatedFen,
        SUM(CASE WHEN cost_source='REPORTED' THEN upstream_cost_fen ELSE 0 END) reportedFen,
        SUM(CASE WHEN cost_source='UNKNOWN' OR upstream_cost_fen IS NULL THEN 1 ELSE 0 END) unknownCalls,
        SUM(CASE WHEN ${exactEvidenceSql} THEN 1 ELSE 0 END) matchedCalls,
        SUM(CASE WHEN NOT ${evidenceSql} THEN 1 ELSE 0 END) unmatchedCalls FROM compute_attempts attempt WHERE ${where}`, params),
      filters: { days, evidenceMatch: evidenceMatch || null },
    };
  }

  // ── 算力网关（new-api）：配置 / 测连 / 渠道 / 令牌分发 ──────────────────────
  if (part === '/compute-gateway' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { config: getComputeGatewayConfig() };
  }
  if (part === '/compute-gateway' && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const config = saveComputeGatewayConfig(ctx.body || {}, { password: ctx.body?.password });
    // 路由缓存里存着「哪个学生用哪张令牌」，改完配置立刻失效 ——
    // 否则 60 秒内还在用旧地址/旧令牌，表现就是「改了没生效」。
    clearGatewayRouteCache();
    audit(ctx, 'COMPUTE_GATEWAY_UPDATE', 'PLATFORM_SETTING', 'compute_gateway', null, { baseUrl: config.baseUrl, username: config.username, enabled: config.enabled, passwordChanged: Boolean(ctx.body?.password) });
    return { config };
  }
  if (part === '/compute-gateway/test' && method === 'POST') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return testComputeGateway();
  }
  if (part === '/compute-gateway/usage' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const days = integer(ctx.search.get('days'), '统计天数', { min: 1, max: 90, fallback: 7 });
    return gatewayUsageOverview({ days });
  }
  // 算力单价（每次调用预估单价，用于折算池子消耗）+ 池子（学生 × 课包）的用量报表
  if (part === '/compute-pricing' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { pricing: getComputePricing() };
  }
  if (part === '/compute-pricing' && method === 'PUT') {
    requireRole(ctx, ['SUPER_ADMIN']);
    // 对外售价观测：这里维护的是「对学生的公告售价」，只用于观测与对账口径，
    // 不扣学生（usage_records.cost_fen / credits_charged 恒为 0），也不是上游真实成本。
    const pricing = saveComputePricing(ctx.body || {});
    audit(ctx, 'COMPUTE_PRICING_UPDATE', 'PLATFORM_SETTING', 'compute_pricing', null, { perCall: pricing.perCall, modelCount: Object.keys(pricing.models).length, baseline: 'OBSERVATION_ONLY' });
    return { pricing, baseline: 'OBSERVATION_ONLY' };
  }
  if (part === '/compute-pools' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const limit = integer(ctx.search.get('limit'), '条数', { min: 1, max: 500, fallback: 100 });
    return { items: classroomBudgetReport({ limit }), lessons: lessonPlatformBudgetOverview(), budgetedSeries: [] };
  }
  // 对账：池子账（应用侧，四种模态、按单价折算）vs 网关账（精确，只含对话/图片）
  if (part === '/compute-pools/reconciliation' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const days = integer(ctx.search.get('days'), '统计天数', { min: 1, max: 90, fallback: 7 });
    return computePoolReconciliation({ days });
  }
  if (part === '/compute-gateway/channels' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { items: await listGatewayChannels() };
  }
  if (part === '/compute-gateway/tokens' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    return { items: await listGatewayTokens() };
  }
  if (part === '/compute-gateway/tokens' && method === 'POST') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const result = await createGatewayToken({
      name: ctx.body?.name,
      budgetFen: integer(ctx.body?.budgetFen, '额度（分）', { min: 0, max: 1000000000, fallback: 0 }),
      models: String(ctx.body?.models || '').trim(),
      unlimited: ctx.body?.unlimited === true,
    });
    // 刚发的令牌要能立刻被学生用上，别等 60 秒缓存过期。
    clearGatewayRouteCache();
    audit(ctx, 'COMPUTE_GATEWAY_TOKEN_CREATE', 'PLATFORM_SETTING', 'compute_gateway', null, { name: String(ctx.body?.name || ''), budgetFen: Number(ctx.body?.budgetFen || 0), unlimited: ctx.body?.unlimited === true });
    return result;
  }

  /**
   * 实测单价（P92）：按 (渠道 × 模型 × 模态) 用上游逐笔实扣反推我们的真实单价，
   * 并带回该组合**当前的合同单价**与偏差（合同价 vs 实测价）。
   *
   * ⚠️ 只读端点：这里不写任何配置。「采纳为成本价」是人在价目表上点按钮、走
   *    PUT /api/admin/billing-config/ai-provider 落库（那才是唯一的写路径）。
   * 只统计上游逐笔回报的实扣（cost_source='REPORTED'），**不含**我们自己按合同价折算的（COMPUTED）——
   * 把 COMPUTED 混进来就是拿自己的假设证明自己的假设，偏差永远为 0。被排除的笔数在 excluded 里列出来。
   */
  if (part === '/billing-config/measured-unit-prices' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const measured = measuredUnitPrices({ days });
    const items = measuredUnitPriceItems(measured, getAiProviderPolicy());
    return {
      days: measured.days, since: measured.since, until: measured.until,
      minSamples: measured.minSamples, onlyCostSource: measured.onlyCostSource,
      items,
      excluded: measured.excluded,
      summary: {
        groups: items.length,
        withPrice: items.filter((item) => item.measuredUnitPrice !== null).length,
        insufficient: items.filter((item) => item.measuredUnitPrice === null).length,
        contractUnconfigured: items.filter((item) => !item.contract.configured).length,
        totalReportedCostFen: Math.round(items.reduce((total, item) => total + Number(item.totalCostFen || 0), 0)),
        totalLedgerCostFen: items.reduce((total, item) => total + Number(item.ledgerCostFen || 0), 0),
      },
      rules: MEASURED_PRICE_RULES,
      meta: measured.meta,
    };
  }

  /**
   * 上游账户余额（实时）—— 平台内部专用，只读。
   * 见文件上方 P113 注释块：逐笔实扣不用这里管，这里只补「我们这把 key 在供应商那边还剩多少」。
   * 遍历当前配置里的渠道并发探一遍（每渠道独立超时 + 独立 try/catch，失败只让那一行变红，不影响整页）。
   * 渠道没配 endpoint / 没配 key → 照列但 `skipped:true`，并且**不发出任何请求**。
   */
  if (part === '/billing-config/upstream-wallet' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    requirePlatformPermission(ctx, 'ADMIN_BILLING');
    const channels = (getAiProviderPolicy()?.channels || []).filter((channel) => channel?.id);
    const probes = await Promise.all(channels.map((channel) => probeUpstreamWallet(channel)));
    return {
      fetchedAt: nowIso(),
      scope: 'PLATFORM_INTERNAL',       // 机构端 / 学生端看不到这块（只有 /api/admin/** 有它）
      walletPath: UPSTREAM_WALLET_PATH,
      timeoutMs: UPSTREAM_WALLET_TIMEOUT_MS,
      channels: probes,
      summary: {
        total: probes.length,
        ok: probes.filter((item) => item.ok).length,
        failed: probes.filter((item) => !item.ok && !item.skipped).length,
        skipped: probes.filter((item) => item.skipped).length,
      },
    };
  }

  if (part === '/dashboard/overview' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const orgFilter = String(ctx.search.get('orgId') || '').trim();
    const fromProvided = ctx.search.has('from'); const from = fromProvided ? String(ctx.search.get('from') || '').trim() : '';
    const toProvided = ctx.search.has('to'); const to = toProvided ? String(ctx.search.get('to') || '').trim() : '';
    if (orgFilter && !row('SELECT id FROM organizations WHERE id=?', [orgFilter])) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    const fromTime = from ? new Date(from) : null;
    const toTime = to ? new Date(to) : null;
    if (fromProvided && (!from || !fromTime || Number.isNaN(fromTime.getTime()) || fromTime.toISOString() !== from)) throw errors.badRequest('开始时间必须是有效 ISO 时间', 'INVALID_FROM');
    if (toProvided && (!to || !toTime || Number.isNaN(toTime.getTime()) || toTime.toISOString() !== to)) throw errors.badRequest('结束时间必须是有效 ISO 时间', 'INVALID_TO');
    if (fromTime && toTime && fromTime >= toTime) throw errors.badRequest('开始时间必须早于结束时间', 'INVALID_TIME_RANGE');
    const upperTime = toTime || new Date();
    const lowerTime = fromTime || new Date(upperTime.getTime() - 29 * 86400000);
    const since = lowerTime.toISOString();
    const until = upperTime.toISOString();
    const scoped = (table) => {
      const conditions = [`${table}.created_at>=?`, `${table}.created_at<?`];
      const params = [since, until];
      if (orgFilter) { conditions.push(`${table}.org_id=?`); params.push(orgFilter); }
      return { where: conditions.join(' AND '), params };
    };
    const singleNumber = (sql, params = []) => Number(row(sql, params)?.n || 0);
    const organizations = singleNumber("SELECT COUNT(*) n FROM organizations WHERE (?='' OR id=?)", [orgFilter, orgFilter]);
    const activeOrganizations = singleNumber("SELECT COUNT(*) n FROM organizations WHERE (?='' OR id=?) AND status IN ('TRIAL','ACTIVE')", [orgFilter, orgFilter]);
    const orgScope = orgFilter ? rows('SELECT id,name,status FROM organizations WHERE id=?', [orgFilter]) : rows('SELECT id,name,status FROM organizations');
    const orgIds = orgScope.map((item) => item.id);
    const usersScope = orgFilter ? "org_id=?" : "org_id IS NOT NULL";
    const usersParams = orgFilter ? [orgFilter] : [];
    const teachers = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='TEACHER' AND deleted_at IS NULL AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>?)`, [...usersParams, nowIso()]);
    const students = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='STUDENT' AND deleted_at IS NULL AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>?)`, [...usersParams, nowIso()]);
    const admins = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='ORG_ADMIN' AND deleted_at IS NULL AND status='ACTIVE' AND (expires_at IS NULL OR expires_at>?)`, [...usersParams, nowIso()]);
    const classes = singleNumber(`SELECT COUNT(*) n FROM class_sessions WHERE (?='' OR org_id=?) AND status='ACTIVE'`, [orgFilter, orgFilter]);
    const publishedCourses = singleNumber(`SELECT COUNT(*) n FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED'`);
    const activeAssignments = singleNumber(`SELECT COUNT(*) n FROM course_assignments assignment WHERE ${assignmentActiveSql()} AND (?='' OR org_id=?)`, [orgFilter, orgFilter]);
    const marketplaceCourses = singleNumber(`SELECT COUNT(*) n FROM course_series WHERE owner_type='PLATFORM' AND status='PUBLISHED' AND marketplace_status='APPROVED'`);
    const classSessions = singleNumber(`SELECT COUNT(*) n FROM class_sessions session WHERE (LENGTH(?)=0 OR session.org_id=?) AND session.started_at>=? AND session.started_at<?`, [orgFilter, orgFilter, since, until]);
    const projects = singleNumber(`SELECT COUNT(*) n FROM student_projects WHERE (?='' OR org_id=?) AND created_at>=? AND created_at<?`, [orgFilter, orgFilter, since, until]);
    const works = singleNumber(`SELECT COUNT(*) n FROM works WHERE (?='' OR org_id=?) AND submitted_at>=? AND submitted_at<?`, [orgFilter, orgFilter, since, until]);
    // ── B4 统计指标细化：新增口径都写明来源，免得「这个数从哪来的」说不清 ──
    const newStudents = singleNumber(`SELECT COUNT(*) n FROM users WHERE ${usersScope} AND role='STUDENT' AND deleted_at IS NULL AND created_at>=? AND created_at<?`, [...usersParams, since, until]);
    const activeStudents = singleNumber("SELECT COUNT(DISTINCT student_id) n FROM student_projects WHERE (?='' OR org_id=?) AND created_at>=? AND created_at<?", [orgFilter, orgFilter, since, until]);
    const lessonCompletions = singleNumber(`SELECT COUNT(*) n FROM session_students progress JOIN class_sessions classroom ON classroom.id=progress.session_id WHERE (?='' OR classroom.org_id=?) AND progress.status='COMPLETED' AND progress.completed_at>=? AND progress.completed_at<?`, [orgFilter, orgFilter, since, until]);
    // 官网匿名转化漏斗已随该功能整体下线（2026-09-16，用户要求彻底删除）：
    // 前端不再上报、服务端不再接收，这里也就不再返回 site 字段。
    // analytics_events 表与历史数据保留（本仓库惯例：删代码不删表），需要时可查库回溯。
    const usage = scoped('usage_records');
    const usageTotal = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where}`, usage.params);
    const usageSuccess = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='SUCCESS'`, usage.params);
    const usageFailed = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='FAILED'`, usage.params);
    const usageBlocked = singleNumber(`SELECT COUNT(*) n FROM usage_records WHERE ${usage.where} AND status='BLOCKED'`, usage.params);
    const abnormalTasks = usageFailed + usageBlocked;
    const aiTasks = singleNumber(`SELECT COUNT(*) n FROM generation_jobs WHERE ${scoped('generation_jobs').where}`, scoped('generation_jobs').params);
    // 2026-09-13（P4 删积分）：byOrg / byModality 从「积分」改成算力金额（分）——与算力层同一份账本。
    const byOrg = rows(`SELECT organization.id,organization.name,COALESCE(SUM(CASE WHEN usage.status='SUCCESS' THEN (SELECT CASE WHEN COUNT(*)=0 OR SUM(CASE WHEN a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(a.upstream_cost_fen) END FROM compute_attempts a WHERE a.call_id=usage.compute_call_id) ELSE 0 END),0) fen,COUNT(usage.id) calls
      FROM organizations organization LEFT JOIN usage_records usage ON usage.org_id=organization.id AND usage.created_at>=? AND usage.created_at<?
      ${orgFilter ? 'WHERE organization.id=?' : ''} GROUP BY organization.id ORDER BY fen DESC,organization.name ASC LIMIT 10`, orgFilter ? [since, until, orgFilter] : [since, until]).map((item) => ({ id: item.id, name: item.name, costFen: Number(item.fen || 0), calls: Number(item.calls || 0) }));
    const byModality = rows(`SELECT modality,COUNT(*) calls,COALESCE(SUM((SELECT SUM(a.upstream_cost_fen) FROM compute_attempts a WHERE a.call_id=usage_records.compute_call_id AND a.cost_source<>'UNKNOWN')),0) fen,COUNT(CASE WHEN status='SUCCESS' THEN 1 END) successCalls,COUNT(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 END) abnormalCalls
      FROM usage_records WHERE ${usage.where} GROUP BY modality ORDER BY fen DESC,modality ASC`, usage.params).map((item) => ({ modality: item.modality, calls: Number(item.calls || 0), costFen: Number(item.fen || 0), successCalls: Number(item.success_calls ?? item.successCalls ?? 0), abnormalCalls: Number(item.abnormal_calls ?? item.abnormalCalls ?? 0) }));
    // ── 统计：算力层（单位是「元」，来自应用侧算力池账本 —— 与「算力网关」页同一份数据）──
    // 为什么不再用 credits：积分已废弃（2026-09-13 P4），钱一律看算力池账本 cost_fen。
    // 这里直接给「花了多少钱、花在哪个模态上、哪个池子快满了」。
    const computeWhere = `record.created_at>=? AND record.created_at<? AND record.series_id IS NOT NULL${orgFilter ? ' AND record.org_id=?' : ''}`;
    const computeParams = orgFilter ? [since, until, orgFilter] : [since, until];
    const attemptScope = scoped('compute_attempts');
    const computeTotals = row(`SELECT SUM(CASE WHEN cost_source<>'UNKNOWN' THEN upstream_cost_fen ELSE 0 END) fen, COUNT(*) calls,
      SUM(CASE WHEN status='SUCCESS' THEN 1 ELSE 0 END) successCalls,
      SUM(CASE WHEN cost_source='UNKNOWN' OR upstream_cost_fen IS NULL THEN 1 ELSE 0 END) unknownCalls
      FROM compute_attempts WHERE ${attemptScope.where}`, attemptScope.params);
    const computeByModality = rows(`SELECT modality,SUM(CASE WHEN cost_source<>'UNKNOWN' THEN upstream_cost_fen ELSE 0 END) fen,COUNT(*) calls
      FROM compute_attempts WHERE ${attemptScope.where} GROUP BY modality ORDER BY fen DESC`,attemptScope.params);
    // 池子健康度是**存量口径**（不随筛选时间变化）：有消耗的池子里，多少接近上限、多少已用尽。
    // 复用同一份报表口径（classroomBudgetReport），避免两处各算一套。
    const poolRows = classroomBudgetReport({ limit: 500, orgId: orgFilter });
    const pools = {
      counted: poolRows.length,
      unlimited: poolRows.filter((item) => item.budgetFen == null).length,
      unknown: poolRows.filter(item => item.budgetState === 'UNKNOWN').length,
      nearLimit: poolRows.filter((item) => item.usagePercent != null && item.usagePercent >= 80 && item.usagePercent < 100).length,
      exhausted: poolRows.filter((item) => item.budgetState === 'OVER_BUDGET').length,
      // 超支金额（元）：只把**算得出超支**的课堂加起来；有任何一场成本未知，整条数字标成 null
      // （用户口径：要能看出「有没有超出、超了多少」；不知道就得说不知道）。
      overBudgetYuan: poolRows.some((item) => item.budgetState === 'OVER_BUDGET' && item.overBudgetFen == null)
        ? null
        : poolRows.reduce((total, item) => total + (item.overBudgetFen || 0), 0) / 100,
      knownCostYuan: poolRows.reduce((total,item) => total + item.knownCostFen,0) / 100,
      // 总成本保持 null：有课堂成本未知时，给一个数字等于把「不知道」说成「知道」
      usedYuan: null,
    };
    // 超支的课堂明细（最多 5 条，最新的在前）：工作台要能一眼看到「哪节课、哪家机构、超了多少」
    const overBudgetSessions = poolRows
      .filter((item) => item.budgetState === 'OVER_BUDGET')
      .slice(0, 5)
      .map((item) => ({
        sessionId: item.sessionId, lessonTitle: item.lessonTitle, orgName: item.orgName, sessionTitle: item.sessionTitle,
        budgetFen: item.budgetFen, knownCostFen: item.knownCostFen, overBudgetFen: item.overBudgetFen, studentCount: item.studentCount,
      }));
    const platformBudgetAlert = {
      lessons: lessonPlatformBudgetOverview()
        .filter((item) => item.overBudgetSessions > 0)
        .map((item) => ({
          lessonId: item.lessonId, lessonTitle: item.lessonTitle, seriesTitle: item.seriesTitle || null, platformBudgetFen: item.platformBudgetFen,
          budgetFen: item.budgetFen, knownCostFen: item.knownCostFen, overBudgetFen: item.overBudgetFen,
          overBudgetSessions: item.overBudgetSessions, sessionCount: item.sessionCount, orgCount: item.orgCount,
          unknownSessions: item.unknownSessions,
        }))
        .sort((left, right) => (right.overBudgetFen || 0) - (left.overBudgetFen || 0)),
      sessions: overBudgetSessions,
    };
    const computeTopStudents = [];

    // ── 统计：内容层（课包/课时的使用热度 + 作品发布情况）──
    const lessonHot = rows(`SELECT lesson.id, lesson.title, series.title AS series_title, COUNT(session.id) AS sessions
        FROM course_lessons lesson
        JOIN course_series series ON series.id = lesson.series_id
        LEFT JOIN class_sessions session ON session.lesson_id = lesson.id AND session.started_at>=? AND session.started_at<?
       WHERE series.owner_type='PLATFORM'
       GROUP BY lesson.id HAVING sessions > 0 ORDER BY sessions DESC, lesson.sort ASC LIMIT 5`, [since, until]).map((item) => ({ id: item.id, title: item.title, seriesTitle: item.series_title, sessions: Number(item.sessions || 0) }));
    // 作品发布：两条链路（画布 works / VibeCoding submissions）合并计数 —— 与用户看到的「一套状态话术」同口径
    const submittedWorks = singleNumber(`SELECT (SELECT COUNT(*) FROM works WHERE submitted_at>=? AND submitted_at<?) + (SELECT COUNT(*) FROM vibecoding_submissions WHERE submitted_at>=? AND submitted_at<?) n`, [since, until, since, until]);
    const content = {
      lessonHot,
      submittedWorks,
      // 在广场上 = 两条链路各自的 is_public（与 worksState 的判据一致）
      onPlaza: singleNumber("SELECT (SELECT COUNT(*) FROM works WHERE is_public=1) + (SELECT COUNT(*) FROM vibecoding_submissions WHERE is_public=1) n"),
      featured: singleNumber("SELECT (SELECT COUNT(*) FROM works WHERE featured_at IS NOT NULL) + (SELECT COUNT(*) FROM vibecoding_submissions WHERE featured_at IS NOT NULL) n"),
      // 2026-09-13（C2）：画布链路数**独立状态** UNPUBLISHED（以前数 teacher_comment，会把「未通过」也算成已下架）
      unpublished: singleNumber("SELECT (SELECT COUNT(*) FROM works WHERE status='UNPUBLISHED') + (SELECT COUNT(*) FROM vibecoding_submissions WHERE is_public=0 AND unpublish_reason IS NOT NULL AND unpublish_reason<>'') n"),
      lessonsPublished: singleNumber("SELECT COUNT(*) n FROM course_lessons WHERE status='PUBLISHED'"),
    };

    return {
      metrics: {
        organizations, activeOrganizations, admins, teachers, students,
        publishedCourses, activeAssignments, activeClasses: classes, classSessions, projects, works,
        aiTasks, abnormalTasks, usageCalls: usageTotal, successfulCalls: usageSuccess, failedCalls: usageFailed, blockedCalls: usageBlocked,
        newStudents, activeStudents, lessonCompletions,
      },
      byOrg, byModality,
      compute: {
        totalYuan: null, knownCostYuan: Number((Number(computeTotals?.fen || 0) / 100).toFixed(2)), costBasis: 'KNOWN_UPSTREAM_ONLY',
        calls: Number(computeTotals?.calls || 0), unknownCalls: Number(computeTotals?.unknownCalls || 0),
        successCalls: Number(computeTotals?.successCalls || 0),
        byModality: computeByModality.map((item) => ({ modality: item.modality, yuan: Number((Number(item.fen || 0) / 100).toFixed(2)), calls: Number(item.calls || 0) })),
        pools, topStudents: computeTopStudents,
        // 预算超支预警（用户口径：要能看到有没有超出、超了多少，并在工作台明确提示）
        budgetAlert: platformBudgetAlert,
      },
      content,
      filters: { orgId: orgFilter || null, from: since, to: until },
      meta: {
        generatedAt: nowIso(), timezone: 'UTC', dataSource: 'local SQLite', version: 'P4-A01',
        metricDefinitions: {
          organizations: '机构总数；orgId 筛选后为 1。',
          activeOrganizations: "状态为 TRIAL 或 ACTIVE 的机构，不含 FROZEN/DISABLED/EXPIRED。",
          admins: '未删除、未禁用且未过期的机构管理员数量。',
          teachers: '未删除、未禁用且未过期的机构教师数量。',
          students: '未删除、未禁用且未过期的机构学生数量。',
          publishedCourses: '平台已发布课程系列数；不受机构筛选影响。',
          activeAssignments: 'ACTIVE 状态课程授权数。',
          activeClasses: '当前 ACTIVE 课堂场次。',
          classSessions: '查询时间内启动的课堂场次。',
          projects: '查询时间内创建的项目数。',
          works: '查询时间内提交的作品数。',
          aiTasks: '查询时间内创建的生成任务数。',
          abnormalTasks: '查询时间内 usage_records 中状态为 FAILED 或 BLOCKED 的调用次数。',
          newStudents: '查询时间内新建的学生账号（deleted_at IS NULL，含已停用）。',
          activeStudents: '查询时间内创建过项目的学生数（按学生去重）。',
          lessonCompletions: '查询时间内有成功使用证据的课堂参与完课人数（按场次）。',
          'site.totals': '区间内匿名事件总量与去重访客数。',
          'byOrg': '按机构统计的算力消耗（分）与调用次数 Top 10。',
          'byModality': '按模态统计的算力消耗（分）与调用次数；含视频与音乐。',
          'compute.totalYuan': '完整上游账单未知时为null；knownCostYuan只表示已知成本小计，不含未知部分。',
          'compute.pools': '课堂平台预警：超额仍可调用，UNKNOWN成本未知与UNCONFIGURED未配置基准分开统计。',
          'content.lessonHot': '查询时间内开过的课堂场次最多的课时 Top 5。',
          'content.onPlaza': '当前在作品广场上的作品数（两条链路 is_public 之和）。',
        },
        boundary: 'from/to 均为左闭右开 UTC ISO 时间；未传时默认最近 30 天；机构与用户统计不按时间过滤。',
      },
    };
  }
  if (['/billing/usage-overview', '/billing/usage-records'].includes(part) && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const page = integer(ctx.search.get('page'), '页码', { min: 1, max: 100000, fallback: 1 });
    const limit = integer(ctx.search.get('limit'), '每页数量', { min: 1, max: 100, fallback: 20 });
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const orgFilter = ctx.search.get('orgId'); const modality = ctx.search.get('modality'); const status = ctx.search.get('status'); const search = String(ctx.search.get('search') || '').trim();
    const startDate = String(ctx.search.get('startDate') || '').trim(); const endDate = String(ctx.search.get('endDate') || '').trim();
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw errors.badRequest('开始日期格式无效', 'INVALID_START_DATE');
    if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw errors.badRequest('结束日期格式无效', 'INVALID_END_DATE');
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const conditions = ['usage.created_at>=?']; const params = [startDate ? startDate + 'T00:00:00.000Z' : since];
    if (startDate && endDate && startDate > endDate) throw errors.badRequest('开始日期不能晚于结束日期', 'INVALID_TIME_RANGE');
    if (ctx.search.get('userId')) { conditions.push('usage.user_id=?'); params.push(ctx.search.get('userId')); }
    if (startDate) { conditions.push('usage.created_at>=?'); params.push(startDate + 'T00:00:00.000Z'); }
    if (endDate) { conditions.push('usage.created_at<=?'); params.push(endDate + 'T23:59:59.999Z'); }
    if (orgFilter) { conditions.push('usage.org_id=?'); params.push(orgFilter); }
    for (const [key,column] of [['studentId','user_id'],['model','model'],['seriesId','series_id'],['sessionId','class_session_id']]) if (ctx.search.get(key)) { conditions.push(`usage.${column}=?`); params.push(ctx.search.get(key)); }
    if (ctx.search.get('channelId')) { conditions.push('EXISTS (SELECT 1 FROM compute_attempts ca WHERE ca.call_id=usage.compute_call_id AND ca.channel_id=?)'); params.push(ctx.search.get('channelId')); }
    if (ctx.search.get('lessonId')) { conditions.push('EXISTS (SELECT 1 FROM class_sessions cs WHERE cs.id=usage.class_session_id AND cs.lesson_id=?)'); params.push(ctx.search.get('lessonId')); }

    if (modality) { conditions.push('usage.modality=?'); params.push(modality); }
    if (['SUCCESS', 'FAILED', 'BLOCKED'].includes(status)) { conditions.push('usage.status=?'); params.push(status); }
    if (search) {
      conditions.push('(organization.name LIKE ? OR user.login LIKE ? OR user.display_name LIKE ? OR project.title LIKE ? OR work.title LIKE ?)');
      const keyword = '%' + search.replace(/[%_]/g, (char) => '[' + char + ']') + '%';
      params.push(keyword, keyword, keyword, keyword, keyword);
    }
    const sortKey = String(ctx.search.get('sort') || 'created').trim();
    const sort = Object.hasOwn({ created: true, costFen: true }, sortKey) ? sortKey : 'created';
    const orderBy = sort === 'costFen' ? `(SELECT CASE WHEN COUNT(*)=0 OR SUM(CASE WHEN a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(a.upstream_cost_fen) END FROM compute_attempts a WHERE a.call_id=usage.compute_call_id) DESC,usage.created_at DESC,usage.id DESC` : 'usage.created_at DESC,usage.id DESC';
    const where = conditions.join(' AND ');
    const countFromWhere = `FROM usage_records usage JOIN organizations organization ON organization.id=usage.org_id LEFT JOIN users user ON user.id=usage.user_id LEFT JOIN student_projects project ON project.id=usage.project_id LEFT JOIN works work ON work.id=usage.work_id ${where ? 'WHERE ' + where : ''}`;
    const total = Number(row(`SELECT COUNT(*) n ${countFromWhere}`, params)?.n || 0);
    const unknownCosts = Number(row(`SELECT COUNT(*) n ${countFromWhere} AND (usage.compute_call_id IS NULL OR NOT EXISTS (SELECT 1 FROM compute_attempts a WHERE a.call_id=usage.compute_call_id) OR EXISTS (SELECT 1 FROM compute_attempts a WHERE a.call_id=usage.compute_call_id AND (a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL)))`, params)?.n || 0);
    const totalFen = Number(row(`SELECT COALESCE(SUM(CASE WHEN usage.status='SUCCESS' THEN (SELECT CASE WHEN COUNT(*)=0 OR SUM(CASE WHEN a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(a.upstream_cost_fen) END FROM compute_attempts a WHERE a.call_id=usage.compute_call_id) ELSE 0 END),0) n ${countFromWhere}`, params)?.n || 0);
    if (part === '/billing/usage-overview') return {
      totalFen, knownCostFen: totalFen, unknownCosts, costBasis: 'KNOWN_UPSTREAM_ONLY', calls: total,
      usage: rows(`SELECT usage.modality, SUM(CASE WHEN usage.status='SUCCESS' THEN (SELECT CASE WHEN COUNT(*)=0 OR SUM(CASE WHEN a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(a.upstream_cost_fen) END FROM compute_attempts a WHERE a.call_id=usage.compute_call_id) ELSE 0 END) costFen, COUNT(*) calls ${countFromWhere} GROUP BY usage.modality ORDER BY costFen DESC`, params),
      topOrgs: rows(`SELECT organization.id,organization.name,SUM(CASE WHEN usage.status='SUCCESS' THEN (SELECT CASE WHEN COUNT(*)=0 OR SUM(CASE WHEN a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(a.upstream_cost_fen) END FROM compute_attempts a WHERE a.call_id=usage.compute_call_id) ELSE 0 END) costFen ${countFromWhere} GROUP BY organization.id ORDER BY costFen DESC LIMIT 10`, params),
    };
    const offset = (page - 1) * limit;
    const items = rows(
      `SELECT usage.*,organization.name organization_name,user.login user_login,user.display_name user_name,project.title project_title,work.title work_title,session.id session_id,session.lesson_id session_lesson_id,session.class_id class_id,session.title class_name FROM usage_records usage JOIN organizations organization ON organization.id=usage.org_id LEFT JOIN users user ON user.id=usage.user_id LEFT JOIN student_projects project ON project.id=usage.project_id LEFT JOIN works work ON work.id=usage.work_id LEFT JOIN class_sessions session ON session.id=usage.class_session_id ${where ? 'WHERE ' + where : ''} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map((item) => ({
      id: item.id, orgId: item.org_id, organizationName: item.organization_name || null,
      userId: item.user_id, userLogin: item.user_login || null, userName: item.user_name || null,
      classSessionId: item.class_session_id || null, classId: item.class_id || null, className: item.class_name || null,
      lessonId: item.session_lesson_id || item.lesson_id || null, projectId: item.project_id || null, projectTitle: item.project_title || null,
      workId: item.work_id || null, workTitle: item.work_title || null, modality: item.modality, model: item.model,
      historicalSaleFen: Number(item.cost_fen || 0),
      costFen: item.compute_call_id ? row("SELECT CASE WHEN COUNT(*)=0 OR SUM(CASE WHEN cost_source='UNKNOWN' OR upstream_cost_fen IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(upstream_cost_fen) END fen FROM compute_attempts WHERE call_id=?",[item.compute_call_id])?.fen ?? null : null,
      pricingSnapshot: parseJson(item.pricing_snapshot, {}),
      attempts: item.compute_call_id ? rows('SELECT id,attempt,channel_id channelId,provider,model,status,task_id taskId,cost_source costSource,upstream_cost_fen upstreamCostFen,error_code errorCode,error_message errorMessage,output_started outputStarted FROM compute_attempts WHERE call_id=? ORDER BY attempt', [item.compute_call_id]) : [],
      // C3 前置：上游返回过就带上（多数多模态接口不返回，所以允许为 0）
      inputTokens: Number(item.input_tokens || 0), outputTokens: Number(item.output_tokens || 0),
      status: item.status, failCode: item.fail_code || null, createdAt: item.created_at,
    }));
    return { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), sort };
  }

  /**
   * 「机构 → 学生」消耗下钻（2026-09-13，用户要的「平台能看到所有机构和下面学生的消耗」）。
   *
   * 归属来自算力池账本 usage_records 的 org_id + user_id —— **不需要给学生发 API key**：
   * 学生不是拿 key 直连上游，而是经我们的后端调用，后端从登录会话就知道是谁在调。
   * 所以只要机构/学员存在，归属天然成立（新机构、新学员都不用做任何「分发」动作）。
   *
   * 返回两块：orgs（所有机构，含零消耗的，便于一眼看出「谁还没用过」）与
   * students（**选中机构**下每个学员的汇总）。days 用左闭右开口径，与其他用量口径一致。
   */
  const usageRange = (ctx) => {
    const days = integer(ctx.search.get('days'), '天数', { min: 1, max: 365, fallback: 30 });
    const until = new Date();
    const since = new Date(until.getTime() - days * 86400000);
    return { days, since: since.toISOString(), until: until.toISOString() };
  };
  if (part === '/billing/org-student-usage' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const { days, since, until } = usageRange(ctx);
    const orgId = String(ctx.search.get('orgId') || '').trim();
    if (orgId && !row('SELECT id FROM organizations WHERE id=?', [orgId])) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    // 所有机构（含这段时间没有消耗的）：LEFT JOIN 用量，零消耗也列出来
    // 每个机构 / 学员**两笔钱并排**（2026-09-15）：
    //   saleFen = 对外售价合计（机构/学员看到的「消耗」，只计成功尝试）；
    //   costFen = **我们已知的上游成本**；有任何一笔成本未知就整体给 null（不把已知部分当总额）。
    // 这就是「机构下面学生花的钱 vs 我们的成本」的对照。
    const SALE_FEN = `COALESCE(SUM(CASE WHEN usage.status='SUCCESS' THEN (SELECT SUM(a.sale_price_fen) FROM compute_attempts a WHERE a.call_id=usage.compute_call_id AND a.status='SUCCESS') ELSE 0 END), 0) saleFen`;
    const orgs = rows(`SELECT organization.id, organization.name, organization.status,
        ${SALE_FEN},
        COALESCE(SUM(CASE WHEN usage.status='SUCCESS' THEN (SELECT CASE WHEN COUNT(*)=0 OR SUM(CASE WHEN a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(a.upstream_cost_fen) END FROM compute_attempts a WHERE a.call_id=usage.compute_call_id) ELSE 0 END), 0) fen, COUNT(usage.id) calls, COUNT(DISTINCT usage.user_id) studentCount
      FROM organizations organization
      LEFT JOIN usage_records usage ON usage.org_id = organization.id AND usage.created_at>=? AND usage.created_at<?
      GROUP BY organization.id ORDER BY saleFen DESC, organization.name ASC`, [since, until])
      .map((item) => ({ id: item.id, name: item.name, status: item.status, saleFen: Number(item.saleFen || 0), costFen: Number(item.fen || 0), calls: Number(item.calls || 0), studentCount: Number(item.studentCount || 0) }));
    const students = orgId ? rows(`SELECT student.id, student.login, student.display_name,
        ${SALE_FEN},
        COALESCE(SUM(CASE WHEN usage.status='SUCCESS' THEN (SELECT CASE WHEN COUNT(*)=0 OR SUM(CASE WHEN a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(a.upstream_cost_fen) END FROM compute_attempts a WHERE a.call_id=usage.compute_call_id) ELSE 0 END), 0) fen, COUNT(usage.id) calls,
        COUNT(DISTINCT usage.series_id) seriesCount, MAX(usage.created_at) lastAt
      FROM usage_records usage JOIN users student ON student.id = usage.user_id
      WHERE usage.org_id=? AND usage.created_at>=? AND usage.created_at<?
      GROUP BY student.id ORDER BY saleFen DESC, student.display_name ASC`, [orgId, since, until])
      .map((item) => ({ id: item.id, login: item.login, name: item.display_name || item.login, saleFen: Number(item.saleFen || 0), costFen: Number(item.fen || 0), calls: Number(item.calls || 0), seriesCount: Number(item.seriesCount || 0), lastAt: item.last_at || item.lastAt || null })) : [];
    const totals = { saleFen: orgs.reduce((sum, item) => sum + item.saleFen, 0), costFen: orgs.reduce((sum, item) => sum + item.costFen, 0), calls: orgs.reduce((sum, item) => sum + item.calls, 0), orgCount: orgs.length, activeOrgCount: orgs.filter((item) => item.calls > 0).length };
    return { days, since, until, orgId: orgId || null, orgs, students, totals, costBasis: 'KNOWN_UPSTREAM_ONLY' };
  }
  if (part === '/billing/org-student-usage/export' && method === 'GET') {
    requireRole(ctx, ['SUPER_ADMIN']);
    const { days, since, until } = usageRange(ctx);
    const orgId = String(ctx.search.get('orgId') || '').trim();
    if (orgId && !row('SELECT id FROM organizations WHERE id=?', [orgId])) throw errors.badRequest('机构不存在', 'ORG_NOT_FOUND');
    // 导出「机构 × 学员」两级的明细（选了机构就只导那家），列与页面一致
    const items = rows(`SELECT organization.name orgName, organization.id orgId, student.login studentLogin,
        student.display_name studentName, student.id studentId,
        COALESCE(SUM(CASE WHEN usage.status='SUCCESS' THEN (SELECT CASE WHEN COUNT(*)=0 OR SUM(CASE WHEN a.cost_source='UNKNOWN' OR a.upstream_cost_fen IS NULL THEN 1 ELSE 0 END)>0 THEN NULL ELSE SUM(a.upstream_cost_fen) END FROM compute_attempts a WHERE a.call_id=usage.compute_call_id) ELSE 0 END), 0) fen, COUNT(usage.id) calls
      FROM usage_records usage
      JOIN organizations organization ON organization.id = usage.org_id
      JOIN users student ON student.id = usage.user_id
      WHERE usage.created_at>=? AND usage.created_at<?${orgId ? ' AND usage.org_id=?' : ''}
      GROUP BY organization.id, student.id
      ORDER BY fen DESC, organization.name ASC, student.display_name ASC`, orgId ? [since, until, orgId] : [since, until]);
    const content = csvDocument(
      ['机构', '机构ID', '学员', '学员账号', '学员ID', '调用次数', '已知成本合计（元，不含未知）'],
      items.map((item) => [item.orgName, item.orgId, item.studentName || item.studentLogin, item.studentLogin, item.studentId, Number(item.calls || 0), (Number(item.fen || 0) / 100).toFixed(2)]),
    );
    audit(ctx, 'PLATFORM_USAGE_EXPORT', 'ORG', orgId || null, null, { count: items.length, days, orgId: orgId || null });
    return { filename: csvFileName(orgId ? 'student-usage' : 'org-student-usage'), content, count: items.length };
  }
  return null;
}
