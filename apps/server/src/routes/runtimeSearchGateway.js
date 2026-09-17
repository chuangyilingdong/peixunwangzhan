// 「学生运行时 → 平台网关」的**网页搜索**入口（2026-09-17）
//
// 背景：dsh 的网页搜索报 `DeepSeek search has no API key for "DEEPSEEK_API_KEY"` —— 插件
// （`@deepseek-ai/dsh-web-search-deepseek`）手里没有任何密钥，而它要的这个 key **不能**发给学生：
// 它是我们渠道的真密钥，学生能从自己的进程里把它读出来，既泄漏又能绕过账本花钱。
//
// 摸清之后发现原设想是错的：这个插件调的**不是搜索接口**，而是 **Anthropic 协议的 `/messages`**
// （插件源码：`const endpoint = `${options.baseURL}/messages``），搜索是「模型一跳里的服务端
// web_search 工具」。所以这里要的不是「加一个搜索端点」，而是给网关加**一条 Anthropic 协议透传**：
// 插件把 base 指到我们网关（`DEEPSEEK_SEARCH_BASE_URL`，由宿主脚本注入），密钥给运行时密钥
// （`DEEPSEEK_API_KEY` = 那把短时的、绑课堂的密钥），我们在这一跳**验身份 → 过门禁 →
// 换真密钥转发 → 记账**。
//
// 三条与聊天那条路**完全共用同一套实现**（不是各写一份，那种迟早走偏）：
//   ① 身份 `verifyRuntimeKey`：签名里带着机构/学生/课时/课堂，调用方改不了归属；
//   ② 门禁 `assertRuntimeClassroomActive`：每通调用都重判「课堂仍在进行 + 学生仍在名单里」；
//   ③ 记账 `recordAiUsage` + `compute_attempts`：上游 tokens 与按合同单价折算的成本都落账。
//
// 协议不翻译（Anthropic 进、Anthropic 出），只动两处**必须由我们决定**的东西：
//   · `model`：换成我们自己渠道解析出来的模型名（绝不把调用方报的字符串原样发上游）；
//   · `tools`：只留 web_search 类服务端工具 —— 这个端点就是给学生做网页搜索的，
//     放行任意服务端工具等于把网关变成一台「能点上游任何服务端能力」的机器。
import { errors, id, json, nowIso, q } from '../lib.js';
import { getAiProviderPolicy } from './billingConfig.js';
import {
  verifyRuntimeKey, readRuntimeToken, assertRuntimeClassroomActive,
  searchChannelSelection, searchUpstreamCredentials,
} from './runtimeGateway.js';
import { recordAiUsage } from '../services/creditUsage.js';
import { applyGatewayRoute } from '../services/computeGateway.js';
import { assertComputePoolBudget, priceFenFor } from '../services/computePool.js';
import { assertExternalAiAllowed, normalizeProviderError, PROVIDER_ERROR_CODES } from '../services/providerContract.js';
import { collectUsageEvidence, computeContractCost, contractCostRuleSnapshot } from '../services/upstreamCost.js';

/**
 * 宿主脚本注入给插件的 base（`DEEPSEEK_SEARCH_BASE_URL`）指向这里 —— 插件自己会再拼 `/messages`。
 * 见 `deploy/dsh-student/host-user/run-student-user.sh`。
 */
export const SEARCH_GATEWAY_PATH = '/api/gateway/v1/search/messages';

// 上游一次搜索是「模型一跳 + 最多 max_uses 次检索」，比聊天慢；但仍要在 nginx 给
// `^/api/gateway/` 放宽的 600s 之内给结果，否则又变成「不报错、只表现为卡住」。
const SEARCH_TIMEOUT_MS = Math.max(30000, Math.min(540000, Number(process.env.RUNTIME_SEARCH_TIMEOUT_MS || 240000)));
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;
const MAX_TOKENS_CEILING = 16384;
// 一次请求最多允许几次检索：每多一次检索就多一跳的 token 与一笔检索费，上限由我们说了算。
const MAX_SEARCH_USES_CEILING = 10;

const isWebSearchTool = (tool) => Boolean(tool) && typeof tool === 'object'
  && String(tool.type || '').toLowerCase().startsWith('web_search');

/** 只留 web_search 类服务端工具，并把 `max_uses` 夹到上限。没有可用的工具就直接说清楚。 */
function searchTools(raw) {
  const tools = (Array.isArray(raw) ? raw : []).filter(isWebSearchTool).map((tool) => {
    const uses = Math.floor(Number(tool.max_uses));
    return { ...tool, max_uses: Number.isFinite(uses) && uses > 0 ? Math.min(uses, MAX_SEARCH_USES_CEILING) : MAX_SEARCH_USES_CEILING };
  });
  if (!tools.length) throw errors.badRequest('搜索请求必须带 web_search 服务端工具（这个端点只做网页搜索）', 'RUNTIME_SEARCH_TOOL_REQUIRED');
  return tools;
}

/** 转发体：Anthropic 的字段**原样带过**，只换掉上面说的那两处（外加补 max_tokens 的默认值）。 */
function forwardedBody(body, { model, tools }) {
  const maxTokens = Math.floor(Number(body?.max_tokens));
  return {
    ...body,
    model,
    tools,
    // Anthropic 的必填项，缺了上游直接 400；给了也不能由调用方随意放大。
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, MAX_TOKENS_CEILING) : DEFAULT_MAX_TOKENS,
    stream: false,
  };
}

/** Anthropic 方言的错误响应：插件读的是 `error.message`，不是我们的 `{success,error}` 信封。 */
function anthropicError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
  return { __streamed: true };
}

/**
 * 平台错误码 → Anthropic 的错误类型。客户端的重试策略是按这个分类走的
 * （认证 vs 权限 vs 参数），所以不能一律给人一个 invalid_request_error。
 */
function anthropicErrorType(code) {
  const value = String(code || '');
  if (value === 'RUNTIME_KEY_INVALID' || value === 'RUNTIME_KEY_EXPIRED') return 'authentication_error';
  if (value.startsWith('RUNTIME_CLASSROOM') || value === 'RUNTIME_STUDENT_NOT_ACTIVE' || value === 'STUDENT_EXTERNAL_AI_BLOCKED') return 'permission_error';
  if (!value || value === 'INTERNAL_ERROR') return 'api_error';
  return 'invalid_request_error';
}

/** Anthropic 回执 → 我们账本认的用量证据形状（`usage_records` 与成本折算共用）。 */
function anthropicEvidence(parsed) {
  const usage = parsed?.usage || null;
  if (!usage) return collectUsageEvidence({ modality: 'TEXT', result: null });
  return collectUsageEvidence({ modality: 'TEXT', result: { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } } });
}

/** 这次用了几次检索（`usage.server_tool_use.web_search_requests`）：留档才能解释花费为什么偏高。 */
function anthropicSearches(parsed) {
  const value = parsed?.usage?.server_tool_use?.web_search_requests;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function upstreamDetail(parsed, status) {
  const detail = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message;
  return detail ? String(detail).slice(0, 500) : `上游返回 HTTP ${status}`;
}

export async function handleRuntimeSearchGateway(ctx) {
  if (String(ctx.pathname || '') !== SEARCH_GATEWAY_PATH || ctx.method !== 'POST') return null;

  const body = ctx.body || {};

  // 从**验身份**开始的所有失败都在本函数内成文 —— 一条都不能交给分发层去套 `{success,error}` 信封：
  // 调用方是 Anthropic 客户端，喂它那个形状只会得到「无法理解的响应体」，
  // 而真正的原因（密钥过期 / 课堂结束了 / 渠道没配密钥）就丢了。
  let channel; let selection; let upstream; let session; let payload;
  try {
    payload = verifyRuntimeKey(readRuntimeToken(ctx));
    session = assertRuntimeClassroomActive(payload);
    if (body.stream === true) throw errors.badRequest('搜索端点不支持流式请求，请去掉 stream', 'RUNTIME_SEARCH_STREAM_UNSUPPORTED');
    if (!Array.isArray(body.messages) || !body.messages.length) throw errors.badRequest('messages 不能为空', 'VALIDATION_REQUIRED');
    const tools = searchTools(body.tools);
    const policy = getAiProviderPolicy();
    const base = searchChannelSelection(policy, String(body.model || '').trim());
    channel = base.channel;
    // 算力网关的路由与聊天同一套（启用时换成网关令牌并按令牌限额走；未启用时原样返回）。
    selection = await applyGatewayRoute(base.selection, {
      orgId: payload.o, studentId: payload.u, lessonId: session.lesson_id || '', modality: 'TEXT',
    });
    // 学生在搜索框里输入的话会**发到平台外部**：与聊天同一个闸门，不许外发时一并挡住搜索。
    assertExternalAiAllowed({ mode: 'external-adapter', allowStudentExternalContent: policy.allowStudentExternalContent });
    // 预算检查与聊天同口径（提示性，不阻断学生）。
    assertComputePoolBudget({ sessionId: session.id });
    upstream = {
      ...searchUpstreamCredentials(channel, selection),
      model: selection.model,
      requestedModel: String(body.model || '').trim(),
      tools,
    };
  } catch (error) {
    return anthropicError(ctx.res, error?.status || 500, anthropicErrorType(error?.code), String(error?.message || '搜索请求被拒绝'));
  }
  const requestedModel = upstream.requestedModel;
  const started = Date.now();
  const attemptId = id('attempt');
  const callId = id('call');
  const providerName = channel?.provider || 'custom';
  const salePriceFen = priceFenFor({ modality: 'TEXT', model: upstream.model });
  // compute_attempts：与聊天那条路同一张表、同一批列。搜索这一跳没有 provider 适配器，
  // 所以自己落一行 —— 不落的话搜索的花费在成本报表里完全看不见，正是本项目最怕的
  // 「用得掉、账上看不到」。用量证据与成本在拿到上游回执后回填。
  q(`INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,modality,channel_id,provider,model,routed_via,status,client_request_id,actual_channel_id,provider_account_ref,sale_price_fen,sale_snapshot,class_session_id,lesson_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [attemptId, callId, 1, payload.o, payload.u, 'TEXT', channel?.id || 'default', providerName, upstream.model,
      selection.gateway ? 'gateway' : 'direct', 'RUNNING', id('req'), selection.gateway ? null : (channel?.id || 'default'),
      channel?.providerAccountRef || null, salePriceFen,
      json({ model: upstream.model, modality: 'TEXT', unitFen: salePriceFen, charged: false, baseline: 'OBSERVATION_ONLY', basis: 'OBSERVATION_ONLY', capturedAt: nowIso() }),
      session.id, session.lesson_id || null, nowIso()]);

  const finish = ({ status, failCode = null, raw = '', evidence = null, webSearches = null, upstreamStatus = null }) => {
    const usage = evidence || collectUsageEvidence({ modality: 'TEXT', result: null });
    const computed = computeContractCost({
      modality: 'TEXT', model: upstream.model,
      unitPrices: channel?.upstreamUnitPrices || null,
      modelUnitPrices: channel?.modelUnitPrices || null,
      usage,
    });
    const hasEvidence = usage.evidence !== 'NONE';
    const ruleSnapshot = computed ? contractCostRuleSnapshot({
      provider: providerName, channelId: channel?.id || 'default', model: upstream.model,
      estimatedCostFen: channel?.modelCosts?.[upstream.model] ?? channel?.estimatedCostFen ?? null,
      computed,
    }) : null;
    // 折算不出来就保持 UNKNOWN，**绝不按 0 计**（与聊天那条路同一条铁律）。
    q("UPDATE compute_attempts SET status=?,cost_source=?,upstream_cost_fen=?,cost_rule_snapshot=COALESCE(?,cost_rule_snapshot),usage_snapshot=?,error_code=?,error_message=?,completed_at=? WHERE id=?",
      [status, computed ? 'COMPUTED' : 'UNKNOWN', computed ? computed.fen : null, ruleSnapshot ? json(ruleSnapshot) : null,
        hasEvidence ? json(usage) : null, failCode, failCode ? String(raw).slice(0, 500) : null, nowIso(), attemptId]);
    recordAiUsage({
      orgId: payload.o, userId: payload.u, sessionId: session.id,
      modality: 'TEXT', model: upstream.model, status, failCode,
      inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0,
      pricing: {
        compute: { callId, saleSnapshot: { model: upstream.model, modality: 'TEXT', unitFen: salePriceFen, charged: false } },
        source: 'dsh-runtime-search-gateway', provider: providerName, mode: channel?.provider || 'custom',
        // 去向与模型解析都留档：对账时能看出「插件报的名字」落在哪个渠道/哪个模型上，
        // 以及这一跳走没走算力网关、用了几次检索（花费偏高时这是第一个要看的数）。
        modelResolution: { requested: requestedModel || null, channelId: channel?.id || null, model: upstream.model },
        webSearch: { requests: webSearches, elapsedMs: Date.now() - started, upstreamStatus },
      },
    });
  };

  let response;
  try {
    response = await fetch(upstream.endpoint, {
      method: 'POST',
      // 与插件一致：不跟随重定向 —— 跟随等于把真密钥交给另一台主机。
      redirect: 'error',
      headers: {
        // 真密钥只出现在这一跳（x-api-key 与 authorization 都给：上游两种都认）。
        'x-api-key': upstream.apiKey,
        authorization: `Bearer ${upstream.apiKey}`,
        'anthropic-version': String(ctx.req?.headers?.['anthropic-version'] || DEFAULT_ANTHROPIC_VERSION),
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'ai-kids-platform-gateway',
      },
      body: JSON.stringify(forwardedBody(body, { model: upstream.model, tools: upstream.tools })),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    finish({ status: 'FAILED', failCode: timedOut ? PROVIDER_ERROR_CODES.TIMEOUT : PROVIDER_ERROR_CODES.UPSTREAM, raw: String(error?.message || error) });
    console.error(`[runtimeSearchGateway] 上游请求失败（${upstream.endpoint}）：${String(error?.message || error)}`);
    return anthropicError(ctx.res, timedOut ? 504 : 502, 'api_error',
      timedOut ? '搜索上游超时，请稍后再试' : '连不上搜索上游，请让管理员检查渠道设置');
  }

  // 一次性读完再回吐（请求体已挡掉 stream，所以这里一定是完整 JSON）：用量必须从响应体里读出来
  // 才能落账，一边流一边记账会变成「记了但记不全」。搜索一次几秒，不存在把学生卡住的问题。
  const raw = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }

  if (!response.ok) {
    const normalized = normalizeProviderError(Object.assign(new Error(upstreamDetail(parsed, response.status)), { status: response.status }), { status: response.status }) || {};
    // 记 FAILED 也把用量带上（上游即便报错也可能已经计了 token），但折算不出来仍保持 UNKNOWN。
    finish({ status: 'FAILED', failCode: normalized.code || PROVIDER_ERROR_CODES.UPSTREAM, raw, evidence: anthropicEvidence(parsed), webSearches: anthropicSearches(parsed), upstreamStatus: response.status });
    // 上游的错误体原样回吐：它本来就是 Anthropic 方言，插件读得懂（还有上游自己的原话）。
    ctx.res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    ctx.res.end(raw || JSON.stringify({ type: 'error', error: { type: 'api_error', message: `上游返回 HTTP ${response.status}` } }));
    return { __streamed: true };
  }

  finish({ status: 'SUCCESS', evidence: anthropicEvidence(parsed), webSearches: anthropicSearches(parsed), upstreamStatus: response.status });
  ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  ctx.res.end(parsed ? JSON.stringify(parsed) : raw);
  return { __streamed: true };
}
