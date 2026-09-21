import { AI_PROVIDER, AI_PROVIDER_ENDPOINT, AI_PROVIDER_MODEL, AI_PROVIDER_API_KEY, AI_PROVIDER_MODALITY_ENDPOINTS, AI_PROVIDER_POLL_INTERVAL_MS, AI_PROVIDER_VOICE, PUBLIC_SITE_URL } from '../config.js';
import { isMockProvider, providerDefinition, unavailableProvider, validateProviderConfig } from './providerContract.js';
import { openAiCompatibleProvider } from './openaiCompatibleProvider.js';
import { getProviderApiKey } from './providerSecret.js';
import { id, json, nowIso, q, row } from '../lib.js';
import { priceFenFor } from './computePool.js';
import { collectUsageEvidence, computeContractCost, contractCostRuleSnapshot, normalizeModelUnitPrices, normalizeUpstreamUnitPrices, reportedCostRuleSnapshot } from './upstreamCost.js';

// 「我们自己站点上的素材」是哪些域名。上游在境外**抓不到它们**（2026-09-21 实测：
// 要么压根连不上、要么读一半就断），所以适配器会把这些 URL 先传到上游再用上游自己的地址发
// （见 services/upstreamMediaMirror.js）。只在这里传 → 走网关/模拟器那两条分支不会启动镜像。
const SELF_MEDIA_ORIGINS = [PUBLIC_SITE_URL].map((value) => String(value || '').trim()).filter(Boolean);

function svgDataUrl(title, subtitle, hue) {
  const escape = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="hsl(${hue} 75% 52%)"/><stop offset="1" stop-color="hsl(${(hue + 58) % 360} 78% 66%)"/></linearGradient></defs><rect width="960" height="540" fill="url(#g)"/><circle cx="800" cy="115" r="90" fill="#fff" opacity=".25"/><text x="72" y="240" fill="#fff" font-family="Arial, sans-serif" font-size="56" font-weight="700">${escape(title)}</text><text x="72" y="310" fill="#fff" font-family="Arial, sans-serif" font-size="30">${escape(subtitle).slice(0, 46)}</text><text x="72" y="450" fill="#fff" opacity=".85" font-family="Arial, sans-serif" font-size="22">灵动ai学院 · 本地模拟素材</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function mockProvider(model = AI_PROVIDER_MODEL) {
  const labels = { TEXT: '灵感提示词', IMAGE: '画面素材', MUSIC: '音乐素材', VIDEO: '短片素材' };
  // 模拟回复按当前 VibeCoding 的产物约定来写：带文件名的围栏（```语言 文件名）。
  // 这样本地 mock 也能真实走通「流式解析产物 → 落库 → 前端产物卡片」整条链路。
  const mockText = (prompt) => `这是本地模拟回复。\n\n你说的是：${String(prompt || '').slice(0, 200)}\n\n\`\`\`html index.html\n<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <title>本地模拟页面</title>\n</head>\n<body>\n  <h1>本地模拟页面</h1>\n  <script src="script.js"></script>\n</body>\n</html>\n\`\`\`\n\n\`\`\`js script.js\nconsole.log('hello from mock');\n\`\`\`\n`;
  return {
    name: 'local-mock',
    // 如实回报被请求的模型，便于验证「课时指定模型」这类覆盖是否生效
    model,
    capabilities: ['TEXT', 'IMAGE', 'MUSIC', 'VIDEO'],
    async generate({ modality, prompt, title }) {
      const label = title || labels[modality] || '创作素材';
      const hue = [...String(prompt)].reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
      const metadata = { mock: true, modality, prompt };
      if (modality === 'TEXT') {
        metadata.text = mockText(prompt);
        // 本地 mock 按上游形状给一份用量（字数粗算），这样「采集上游用量」这条链在本地也能被守卫跑到
        const text = metadata.text;
        metadata.tokens = { inputTokens: Math.max(1, Math.ceil(String(prompt || '').length / 4)), outputTokens: Math.max(1, Math.ceil(text.length / 4)), totalTokens: 0 };
        metadata.tokens.totalTokens = metadata.tokens.inputTokens + metadata.tokens.outputTokens;
      }
      return {
        assets: [{
          label,
          mimeType: modality === 'IMAGE' ? 'image/svg+xml' : modality === 'TEXT' ? 'text/plain; charset=utf-8' : 'application/x-ai-kids-mock',
          assetUrl: `mock://generation/${Date.now().toString(36)}`,
          previewUrl: svgDataUrl(label, prompt, hue),
          metadata,
        }],
      };
    },
    // 流式：按固定切片逐块回调，让 VibeCoding 的 SSE 链路在本地也能被真实走通。
    async generateStream({ messages, prompt = '', onDelta } = {}) {
      const lastUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message?.role === 'user');
      // 带图片附件的用户消息 content 是**内容块数组**，直接 String() 会变成 "[object Object],[object Object]"。
      const lastUserText = Array.isArray(lastUser?.content)
        ? lastUser.content.filter((block) => block?.type === 'text').map((block) => String(block.text || '')).join(' ').trim()
        : String(lastUser?.content || '');
      const text = mockText(prompt || lastUserText || '');
      let full = '';
      for (const chunk of text.match(/[\s\S]{1,24}/g) || [text]) {
        full += chunk;
        if (typeof onDelta === 'function') onDelta(chunk, full);
      }
      const inputTokens = Math.max(1, Math.ceil(String(prompt || lastUserText || '').length / 4));
      const outputTokens = Math.max(1, Math.ceil(text.length / 4));
      // 按上游形状给 usage（流式那一段上游是最后一帧才给，这里直接一次给全），让采集链路在本地可测
      return { assets: [{ label: 'AI 回复', mimeType: 'text/plain; charset=utf-8', assetUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`, metadata: { mock: true, modality: 'TEXT', text, tokens: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } } }], usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, streamed: true };
    },
  };
}

export function providerSelection({ provider, model, endpoint, channelId, providerAccountRef, requestTemplates, modelRequestTemplates, requestPaths, pollPaths, gateway, apiKey, upstreamUnitPrices, modelUnitPrices } = {}) {
  return {
    provider: String(provider || AI_PROVIDER).trim(),
    model: String(model || AI_PROVIDER_MODEL).trim(),
    endpoint: String(endpoint || AI_PROVIDER_ENDPOINT).trim(),
    channelId: String(channelId || 'default').trim(),
    providerAccountRef: String(providerAccountRef || '').trim() || null,
    requestTemplates: requestTemplates && typeof requestTemplates === 'object' ? requestTemplates : {},
    modelRequestTemplates: modelRequestTemplates && typeof modelRequestTemplates === 'object' ? modelRequestTemplates : {},
    requestPaths: requestPaths && typeof requestPaths === 'object' ? requestPaths : {},
    pollPaths: pollPaths && typeof pollPaths === 'object' ? pollPaths : {},
    // 合同单价（P90）：渠道上配的「上游进价」，折算上游成本用；没配就是 null（→ UNKNOWN，不按 0 计）。
    upstreamUnitPrices: normalizeUpstreamUnitPrices(upstreamUnitPrices),
    // 模型级覆盖：同渠道不同模型合同价不同（qwen-turbo vs qwen-max）时按模型选价，优先级 model > modality。
    modelUnitPrices: normalizeModelUnitPrices(modelUnitPrices),
    // 调用方可以带一把**临时密钥**（例如平台端「用当前渠道试一次」探测一个还没保存的新 key）：
    // 有它就用它，不落库、不影响已保存的配置。
    apiKey: String(apiKey || '').trim(),
    // 算力网关出口（由 services/computeGateway.js 的 applyGatewayRoute 挂上）：
    // 有它就用网关的地址 + 该学生的令牌 key 发请求，否则直连上游。
    gateway: gateway && gateway.endpoint && gateway.apiKey ? { endpoint: String(gateway.endpoint), apiKey: String(gateway.apiKey), tokenName: String(gateway.tokenName || '') } : null,
  };
}

export function providerConfig(selection = {}) {
  const selected = providerSelection(selection);
  // 走网关时凭证是网关令牌，不需要本地再存一份上游 key（key 在网关那一侧）。
  const apiKey = selected.gateway?.apiKey || selected.apiKey || getProviderApiKey(selected.channelId) || getProviderApiKey() || AI_PROVIDER_API_KEY;
  return validateProviderConfig({ ...selected, apiKey });
}
export function generationProviderInfo(selection = {}) {
  const config = providerConfig(selection);
  const definition = providerDefinition(config.provider);
  const adapterAvailable = isMockProvider(config.provider) || Boolean(definition?.adapterAvailable);
  const capabilities = isMockProvider(config.provider) || adapterAvailable ? ['TEXT', 'IMAGE', 'MUSIC', 'VIDEO'] : [];
  return {
    provider: config.provider,
    model: config.model,
    mode: isMockProvider(config.provider) ? 'mock' : adapterAvailable ? 'external-adapter' : 'adapter-required',
    configured: config.valid,
    adapterAvailable,
    capabilities,
    endpointConfigured: Boolean(config.endpoint),
    // 这次调用实际走的是网关还是直连上游，界面/日志能看见，免得「以为在网关里被拦着」
    routedVia: providerSelection(selection).gateway ? 'gateway' : 'direct',
    configError: config.reasons.length ? 'AI_PROVIDER_CONFIG_INVALID' : null,
  };
}
export function getGenerationProvider(selection = {}) {
  const primary = rawGenerationProvider(selection);
  const wrapper = { ...primary, compute: null };
  const execute = async (method, args = {}) => {
    const modality = args.modality || 'TEXT';
    // 对外售价观测：unitFen 按「当前公告价」折算，仅用于观测与对账，**不代表学生被扣费**
    // （charged 恒 false，学生账本 usage_records.cost_fen/credits_charged 恒 0）。baseline 明确标注观测口径。
    const salePriceFen = priceFenFor({ modality, model: primary.model });
    const snapshot = { model: primary.model, modality, unitFen: salePriceFen, charged: false, baseline: 'OBSERVATION_ONLY', capturedAt: nowIso(), basis: 'OBSERVATION_ONLY' };
    const callId = id('call');
    wrapper.compute = { callId, saleSnapshot: snapshot };
    // Gateway owns its routing. Never bypass a student's gateway quota with a direct fallback.
    const candidates = [selection, ...(!selection.gateway && selection.backup ? [selection.backup] : [])];
    for (let index = 0; index < candidates.length; index++) {
      const selected = candidates[index]; const provider = index ? rawGenerationProvider(selected) : primary;
      const attemptId = id('attempt'); const clientRequestId = id('req'); let emitted = false; let submitted = false;
      const context = args.computeContext || selection.computeContext || {};
      const project = args.projectId ? row('SELECT org_id,class_session_id,course_lesson_id FROM student_projects WHERE id=?',[args.projectId]) : null;
      const sessionId = context.sessionId || project?.class_session_id || null;
      const session = sessionId ? row('SELECT org_id,lesson_id FROM class_sessions WHERE id=?',[sessionId]) : null;
      // 观测价按本次实际路由到的模型折算（主/备不同模型价可能不同），只观测、不扣学生。
      const attemptSalePriceFen = priceFenFor({ modality, model: provider.model });
      // 2026-09-18（用户口径：成本只留"价目表 → 合同单价"一套）：
      // 这里原来还有一档 `selected.estimatedCostFen`（渠道卡里手填的"估算成本 分/次"），
      // 它的优先级低于合同单价 —— 也就是说**填了合同单价，这档就完全被忽略、白填**，
      // 而 UI 上两者挤在同一张渠道卡里，没人分得清哪个算数。现在估算那档已从取值链移除：
      // 成本的来源只有三种，且都能说清 —— MOCK（本地模拟）/ REPORTED（上游逐笔回实扣）/
      // COMPUTED（按价目表里的合同单价 × 用量折算）；都没有就是 **UNKNOWN（未知，绝不按 0 计）**。
      // ⚠️ 老库里渠道上残留的 `estimatedCostFen` / `modelCosts` 字段现在**没有读取方**（等价于已退役）。
      const costRuleSnapshot = {
        basis: 'UPSTREAM_REPORTED_OR_UNKNOWN',
        provider: provider.name,
        channelId: selected.channelId || 'default',
        model: provider.model,
        estimatedCostFen: null,
        capturedAt: nowIso(),
      };
      q(`INSERT INTO compute_attempts(id,call_id,attempt,org_id,user_id,project_id,generation_job_id,modality,channel_id,provider,model,routed_via,status,client_request_id,actual_channel_id,provider_account_ref,sale_price_fen,cost_rule_snapshot,sale_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [attemptId,callId,index+1,context.orgId || null,context.userId || args.userId || null,args.projectId || null,context.jobId || null,modality,selected.channelId || 'default',provider.name,provider.model,selected.gateway ? 'gateway' : 'direct','RUNNING',clientRequestId,selected.gateway ? null : (selected.channelId || 'default'),selected.providerAccountRef || null,attemptSalePriceFen,json(costRuleSnapshot),json(snapshot),nowIso()]);
      q('UPDATE compute_attempts SET org_id=?,class_session_id=?,lesson_id=? WHERE id=?',[session?.org_id || context.orgId || project?.org_id || null,sessionId,session?.lesson_id || context.lessonId || project?.course_lesson_id || null,attemptId]);
      const output = (callback) => (...values) => { if (values[0]) { emitted = true; q('UPDATE compute_attempts SET output_started=1 WHERE id=?',[attemptId]); } return callback?.(...values); };
      try {
        const result = await provider[method]({ ...args,
          clientRequestId,
          onEvidence: (evidence = {}) => q(`UPDATE compute_attempts SET response_request_id=COALESCE(?,response_request_id),response_payload_id=COALESCE(?,response_payload_id),usage_id=COALESCE(?,usage_id),gateway_log_id=COALESCE(?,gateway_log_id),actual_channel_id=COALESCE(?,actual_channel_id) WHERE id=?`, [evidence.responseRequestId || null,evidence.responsePayloadId || null,evidence.usageId || null,evidence.gatewayLogId || null,evidence.actualChannelId || null,attemptId]),
          onDelta: output(args.onDelta), onReasoning: output(args.onReasoning),
          onSubmitted: (taskId) => { submitted = true; q("UPDATE compute_attempts SET status='SUBMITTED',task_id=? WHERE id=?",[String(taskId),attemptId]); args.onSubmitted?.(taskId); },
        });
        const reported = !selected.gateway ? result?.assets?.find(asset => asset?.metadata?.reportedCost)?.metadata?.reportedCost : null;
        // 合同单价折算（P90）：用量证据按模态采集（文本看上游 token 回执，图/视频/音乐看请求参数）。
        // 有单价 + 有用量才算得出来；算不出来就保持 UNKNOWN，**绝不按 0 计**。
        const usage = collectUsageEvidence({ modality, result, request: args.options || null });
        const contract = reported ? null : computeContractCost({ modality, model: provider.model, unitPrices: selected.upstreamUnitPrices || null, modelUnitPrices: selected.modelUnitPrices || null, usage });
        // 成本来源只剩这三种（见上面那段注释：估算那档已退役）
        const computedSource = provider.name === 'local-mock' ? 'MOCK' : reported ? 'REPORTED' : contract ? 'COMPUTED' : 'UNKNOWN';
        const upstreamCostFen = computedSource === 'MOCK' ? 0
          : computedSource === 'REPORTED' ? reported.fen
            : computedSource === 'COMPUTED' ? contract.fen
              : null;
        // 快照留住「当时用的价 + 当时的用量」，改价不追溯。
        const ruleSnapshot = contract ? contractCostRuleSnapshot({
          provider: provider.name, channelId: selected.channelId || 'default', model: provider.model,
          estimatedCostFen: null, computed: contract,
        }) : reportedCostRuleSnapshot({
          provider: provider.name, channelId: selected.channelId || 'default', model: provider.model, reported,
        });
        const hasUsageEvidence = usage.evidence !== 'NONE';
        q("UPDATE compute_attempts SET status='SUCCESS',cost_source=?,upstream_cost_fen=?,cost_rule_snapshot=COALESCE(?,cost_rule_snapshot),usage_snapshot=?,completed_at=? WHERE id=?",[computedSource,upstreamCostFen,ruleSnapshot ? json(ruleSnapshot) : null,hasUsageEvidence ? json(usage) : null,nowIso(),attemptId]);
        wrapper.name = provider.name; wrapper.model = provider.model;
        wrapper.compute = { ...wrapper.compute, costSource: computedSource, upstreamCostFen, costRuleSnapshot: ruleSnapshot, usageSnapshot: hasUsageEvidence ? usage : null };
        return { ...result, compute: wrapper.compute };
      } catch (error) {
        // ⚠️ 2026-09-18 晚：这里原来只记 `error.message`，而网络层失败的外层永远只有一句
        // `fetch failed` —— 真正的原因（`ECONNRESET` / `UND_ERR_CONNECT_TIMEOUT` / TLS / DNS…）
        // **在 `error.cause` 里**，不记下来就根本没法排查（这一轮为此刻意绕了很久才定位到"网络层"）。
        // 记成 `fetch failed [ECONNRESET] connect ECONNRESET …`：保留原文，同时一眼能看出原因。
        // 敏感信息照旧擦掉（Bearer / 渠道 key）。
        const causeText = error?.cause ? `${error.cause.code || error.cause.name || ''} ${error.cause.message || ''}`.trim() : '';
        const failMessage = [String(error.message || '调用失败'), causeText ? `[${causeText}]` : ''].filter(Boolean).join(' ')
          .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
          .split(selected.apiKey || '__NO_CONFIGURED_SECRET__').join('[redacted]')
          .split(selected.gateway?.apiKey || '__NO_CONFIGURED_SECRET__').join('[redacted]')
          .slice(0, 1000);
        q("UPDATE compute_attempts SET status='FAILED',error_code=?,error_message=?,completed_at=? WHERE id=?",[String(error.code || 'UPSTREAM_ERROR'),failMessage,nowIso(),attemptId]);
        // Only an explicit pre-acceptance rejection is safe. Network ambiguity, accepted jobs and output never retry.
        if (index + 1 >= candidates.length || emitted || submitted || args.signal?.aborted || error.safeToRetry !== true) throw error;
      }
    }
  };
  wrapper.generate = (args) => execute('generate', args);
  if (primary.generateStream) wrapper.generateStream = (args) => execute('generateStream', args);
  return wrapper;
}

function rawGenerationProvider(selection = {}) {
  const selected = providerSelection(selection);
  const config = providerConfig(selected);  if (isMockProvider(config.provider)) return mockProvider(config.model);
  const definition = providerDefinition(config.provider);
  if (!config.valid || !definition?.adapterAvailable) return unavailableProvider({ name: config.provider, model: config.model, config });
  if (selected.gateway) {
    // 走网关：new-api 提供的是 OpenAI 那套接口，所以**不套**我们自己上游的请求模板/路径
    // （那些是给 MiniMax/Mureka 的私有路径与私有请求体用的，网关不认）→ 用内置的 OpenAI 形状模板。
    // ⚠️ 图片路径要显式给成 **复数** `/v1/images/generations`：new-api 只有复数这一条
    //    （router/relay-router.go 实测），而我们自己的默认路径是单数 `/image/generations` ——
    //    不覆盖的话图片这条会打到网关上不存在的路径（404），且看起来像「网关不支持图片」。
    return openAiCompatibleProvider({
      name: config.provider, model: config.model, endpoint: selected.gateway.endpoint, apiKey: selected.gateway.apiKey,
      modalityEndpoints: AI_PROVIDER_MODALITY_ENDPOINTS, pollIntervalMs: AI_PROVIDER_POLL_INTERVAL_MS, voice: AI_PROVIDER_VOICE,
      requestTemplates: {}, modelRequestTemplates: {}, requestPaths: { IMAGE: '/v1/images/generations' }, pollPaths: {},
    });
  }
  return openAiCompatibleProvider({ name: config.provider, model: config.model, endpoint: config.endpoint, apiKey: selected.apiKey || getProviderApiKey(selected.channelId) || getProviderApiKey() || AI_PROVIDER_API_KEY, modalityEndpoints: AI_PROVIDER_MODALITY_ENDPOINTS, pollIntervalMs: AI_PROVIDER_POLL_INTERVAL_MS, voice: AI_PROVIDER_VOICE, requestTemplates: selected.requestTemplates, modelRequestTemplates: selected.modelRequestTemplates, requestPaths: selected.requestPaths, pollPaths: selected.pollPaths, selfOrigins: SELF_MEDIA_ORIGINS });
}
