// 「学生运行时 → 平台网关」的入口（2026-09-16）
//
// 背景：学生端的 VibeCoding 改用 dsh（DeepSeek Harness）之后，模型调用要**继续走我们的网关**，
// 否则 token 用量与成本就从我们的账本里漏出去了。dsh 侧用 `llm-pi-ai` 的 hand-declared gateway
// 指向这里（`api: openai-completions` + `baseURL` + `apiKeyEnv`），所以这个端点说 OpenAI 兼容的话。
//
// 三条硬要求（都在这里落地）：
//   ① 身份不是浏览器给的：运行时密钥是我们**签发**的（HMAC 签名，内含机构/学生/课时/课堂），
//      调用方改不了归属；密钥里没有的东西一律不认。
//   ② 每一通调用都重新过门禁：课堂必须仍在进行、学生仍在名单里。学生被移出名单或老师结束课堂后，
//      容器里即使还有密钥也调不动了（不用等容器回收）。
//   ③ 每一通调用都记账：与 VibeCoding 原来的链路完全同一套（算力池预算 → 渠道 → recordAiUsage）。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { errors, id, json, nowIso, q, row } from '../lib.js';
import { getAiProviderPolicy } from './billingConfig.js';
import { providerSelectionForModality } from './aiGeneration.js';
import { generationProviderInfo, getGenerationProvider } from '../services/generationProvider.js';
import { recordAiUsage } from '../services/creditUsage.js';
import { applyGatewayRoute } from '../services/computeGateway.js';
import { assertComputePoolBudget, priceFenFor } from '../services/computePool.js';
import { assertExternalAiAllowed, normalizeProviderError, PROVIDER_ERROR_CODES } from '../services/providerContract.js';

const PREFIX = 'rt1';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function secret() {
  const value = String(process.env.RUNTIME_GATEWAY_SECRET || '').trim();
  // 没有密钥就**拒绝服务**，不退回任何弱默认值：这个端点能让调用方花平台的算力钱。
  if (!value) throw errors.conflict('运行时网关未配置密钥', 'RUNTIME_GATEWAY_UNCONFIGURED');
  return value;
}

function sign(body) {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

/** 平台签发：一个学生一节课一把，随容器一起发出去。 */
export function issueRuntimeKey({ orgId, userId, sessionId, lessonId = null, ttlMs = DEFAULT_TTL_MS }) {
  if (!orgId || !userId || !sessionId) throw errors.badRequest('签发运行时密钥需要机构、学生与课堂', 'RUNTIME_KEY_INPUT_REQUIRED');
  const payload = { o: orgId, u: userId, s: sessionId, l: lessonId || null, exp: Date.now() + ttlMs };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${PREFIX}.${body}.${sign(body)}`;
}

function verifyRuntimeKey(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw errors.unauthorized('运行时密钥无效', 'RUNTIME_KEY_INVALID');
  const [, body, mac] = parts;
  const expected = sign(body);
  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw errors.unauthorized('运行时密钥无效', 'RUNTIME_KEY_INVALID');
  let payload = null;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { payload = null; }
  if (!payload?.o || !payload?.u || !payload?.s) throw errors.unauthorized('运行时密钥无效', 'RUNTIME_KEY_INVALID');
  if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) throw errors.unauthorized('运行时密钥已过期', 'RUNTIME_KEY_EXPIRED');
  return payload;
}

/**
 * 每一通调用都重新过门禁：课堂仍在进行 + 学生仍在名单里（ACTIVE）。
 * 这一步不做的话，老师结束课堂之后容器里还能继续烧算力。
 */
function assertRuntimeClassroomActive(payload) {
  const session = row('SELECT id,org_id,lesson_id,status,teacher_id FROM class_sessions WHERE id=?', [payload.s]);
  if (!session || session.org_id !== payload.o) throw errors.forbidden('课堂不存在或不属于该机构', 'RUNTIME_CLASSROOM_UNAVAILABLE');
  if (session.status !== 'ACTIVE') throw errors.forbidden('课堂已经结束，创作环境已关闭', 'RUNTIME_CLASSROOM_INACTIVE');
  if (payload.l && session.lesson_id !== payload.l) throw errors.forbidden('课时与课堂不一致', 'RUNTIME_LESSON_MISMATCH');
  const part = row("SELECT status FROM session_students WHERE session_id=? AND student_id=? AND status='ACTIVE'", [session.id, payload.u]);
  if (!part) throw errors.forbidden('这名学生当前不在课堂名单里', 'RUNTIME_STUDENT_NOT_ACTIVE');
  return session;
}

function readBearer(ctx) {
  // 注意：requestContext() 只带 pathname/search/method，请求头在 ctx.req.headers 上
  // （踩过一次：拿 ctx.headers 永远读不到 Authorization，于是合法密钥也被判 401）。
  const header = String(ctx.req?.headers?.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

// 读图请求（modlens 这类视觉桥）发过来的是 OpenAI 的多模态 content 数组，这里是收口的地方：
// 只认文字与 http(s)/data:image 的图片，其余部分一律丢掉。
// ⚠️ 以前这一层只做 String(content)，数组会被压成 "[object Object]" —— 图片在网关这一跳就没了，
// 上游只看到一句空话，学生的图等于没发（2026-09-16 修）。
const MAX_IMAGE_PARTS_PER_MESSAGE = 4;
const MAX_IMAGE_URL_CHARS = 5_600_000; // 约 4MB 的 base64

function normalizeContentParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '').trim();
    if (type === 'text' || type === 'input_text') {
      const text = String(item.text ?? '');
      if (text.trim()) parts.push({ type: 'text', text });
      continue;
    }
    if (type === 'image_url' || type === 'input_image') {
      if (parts.filter((part) => part.type === 'image_url').length >= MAX_IMAGE_PARTS_PER_MESSAGE) continue;
      const url = String(item.image_url?.url ?? item.image_url ?? item.image ?? '').trim();
      // 只放行能真正被上游取到的图：容器内的文件路径（file:// 等）发出去只会让上游报错
      if (!/^(?:https?:\/\/|data:image\/)/i.test(url) || url.length > MAX_IMAGE_URL_CHARS) continue;
      parts.push({ type: 'image_url', image_url: { url } });
    }
  }
  // 全是文字就退回字符串：文本这条路（也是绝大多数调用）保持原来的形状不变
  return parts.every((part) => part.type === 'text') ? parts.map((part) => part.text).join('\n') : parts;
}

function normalizeMessages(body) {
  const raw = Array.isArray(body?.messages) ? body.messages : [];
  const messages = raw
    .map((item) => ({
      role: ['system', 'user', 'assistant', 'tool'].includes(String(item?.role)) ? String(item.role) : 'user',
      content: normalizeContentParts(item?.content),
    }))
    .filter((item) => (typeof item.content === 'string' ? item.content.trim() !== '' : item.content.length > 0));
  if (!messages.length) throw errors.badRequest('messages 不能为空', 'VALIDATION_REQUIRED');
  return messages.slice(-40);
}

// 给守卫脚本 p97 直接断言这两个纯函数（它们决定「学生的图有没有被压扁」与「名字解析到哪条渠道」）。
export const normalizeRuntimeMessages = normalizeMessages;
export { resolveRuntimeSelection };

const hasImageParts = (messages) => messages.some((item) => Array.isArray(item.content) && item.content.some((part) => part.type === 'image_url'));

// 容器里的模型清单是我们自己写在镜像补丁层里的，**不是上游的真名**。所以报上来的名字只当「意向」：
// 在我们自己渠道的可用模型清单里认得出就用它，认不出就用这条渠道自己的默认模型。
// 绝不把容器报的字符串原样发给上游 —— 轻则上游 400，重则按另一个模型计费（2026-09-16 修）。
function bareModelName(value) {
  const text = String(value || '').trim();
  return text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text;
}

function channelById(policy, channelId) {
  const id = String(channelId || '').trim();
  return id && Array.isArray(policy?.channels) ? policy.channels.find((item) => item.id === id) || null : null;
}

function modelForChannel(channel, requestedModel) {
  const wanted = bareModelName(requestedModel).toLowerCase();
  const known = [...(channel?.models || []), channel?.model].filter(Boolean);
  const hit = wanted ? known.find((item) => String(item).trim().toLowerCase() === wanted) : null;
  return String(hit || channel?.model || '').trim();
}

/** 换成指定渠道的选择：端点、模板、合同单价跟着渠道走；**不带备份渠道**（备份会把图发给纯文本模型）。 */
function selectionOnChannel(policy, channelId, requestedModel) {
  const channel = channelById(policy, channelId);
  if (!channel) throw errors.conflict('平台配置的读图渠道不存在，请让管理员检查渠道设置', 'RUNTIME_VISION_CHANNEL_MISSING');
  const model = modelForChannel(channel, requestedModel);
  const base = providerSelectionForModality(policy, 'TEXT', '');
  const priced = { estimatedCostFen: channel.modelCosts?.[model] ?? channel.estimatedCostFen ?? null };
  if (base.channelId === channel.id) return { ...base, model, ...priced };
  return {
    provider: channel.provider, model, endpoint: channel.endpoint, channelId: channel.id,
    providerAccountRef: channel.providerAccountRef || null,
    requestTemplates: channel.requestTemplates || {}, modelRequestTemplates: channel.modelRequestTemplates || {},
    requestPaths: channel.requestPaths || {}, pollPaths: channel.pollPaths || {},
    upstreamUnitPrices: channel.upstreamUnitPrices || null, modelUnitPrices: channel.modelUnitPrices || null,
    ...priced,
  };
}

/**
 * 容器报的模型名 → 我们渠道里的 model id。
 * ① 带图的请求**默认跟着模型走**：图交给同一条 TEXT 渠道的模型去读（我们的视觉模型本来就能看图，
 *    平台老 VibeCoding 的聊天一直就是这么发的）；只有政策里另配了「读图渠道」才改走那条。
 * ② 文本请求：政策里配了模型路由（管理员指定「这个名字走哪条渠道」）就按路由走（既有语义不变），
 *    没有路由就用平台默认的 TEXT 渠道，同样在它的模型清单里解析名字。
 */
function resolveRuntimeSelection(policy, requestedModel, withImages) {
  // 配了读图渠道 → 图片走它（渠道不存在时 selectionOnChannel 会明确报错，不会静默退回）
  if (withImages && channelById(policy, policy?.visionChannelId)) return selectionOnChannel(policy, policy.visionChannelId, requestedModel);
  const routes = Array.isArray(policy?.modelRoutes) ? policy.modelRoutes : [];
  const wanted = bareModelName(requestedModel).toLowerCase();
  const route = wanted
    ? routes.find((item) => String(item?.modality || '').toUpperCase() === 'TEXT' && bareModelName(item?.model).toLowerCase() === wanted)
    : null;
  if (route?.channelId) return providerSelectionForModality(policy, 'TEXT', route.model);
  const base = providerSelectionForModality(policy, 'TEXT', '');
  const channel = channelById(policy, base.channelId);
  const model = modelForChannel(channel, requestedModel);
  return model && model !== base.model
    ? { ...base, model, estimatedCostFen: channel?.modelCosts?.[model] ?? channel?.estimatedCostFen ?? null }
    : base;
}

function sseWrite(res, payload) {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
}

export async function handleRuntimeGateway(ctx) {
  const path = String(ctx.pathname || '');
  if (path !== '/api/gateway/v1/chat/completions' || ctx.method !== 'POST') return null;

  const payload = verifyRuntimeKey(readBearer(ctx));
  const session = assertRuntimeClassroomActive(payload);
  const body = ctx.body || {};
  const messages = normalizeMessages(body);
  const stream = body.stream === true;

  const policy = getAiProviderPolicy();
  const requestedModel = String(body.model || '').trim();
  const withImages = hasImageParts(messages);
  // 渠道选择与预算检查与 VibeCoding 原链路同一套：机构/学生/课时/课堂四个维度都带上。
  // 带图的请求默认**跟着模型走**（同一条 TEXT 渠道），配了「读图渠道」才改走那条。
  const selection = await applyGatewayRoute(
    resolveRuntimeSelection(policy, requestedModel, withImages),
    { orgId: payload.o, studentId: payload.u, lessonId: session.lesson_id || '', modality: 'TEXT' },
  );
  // 预算检查是**提示性**的（enforced 恒为 false，见 computePool 注释）：课时金额超了只提醒平台，不阻断学生生成
  assertComputePoolBudget({ sessionId: session.id });
  const provider = getGenerationProvider(selection);
  const providerInfo = generationProviderInfo(selection);
  assertExternalAiAllowed({ mode: providerInfo.mode, allowStudentExternalContent: policy.allowStudentExternalContent });

  const completionId = `chatcmpl-${id('rt')}`;
  const created = Math.floor(Date.now() / 1000);
  const record = (status, { text = '', usage = null, failCode = null, providerName = provider.name } = {}) => {
    recordAiUsage({
      orgId: payload.o, userId: payload.u, sessionId: session.id,
      modality: 'TEXT', model: selection.model, status, failCode,
      inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0,
      costFen: provider.compute?.saleSnapshot?.unitFen ?? priceFenFor({ modality: 'TEXT', model: selection.model }),
      pricing: {
        compute: provider.compute, source: 'dsh-runtime-gateway', provider: providerName, mode: selection.provider,
        // 容器报的名字与我们真正调用的渠道/模型都留档：对账时能看出「学生选的那个名字」到底落在哪儿
        modelResolution: { requested: requestedModel || null, withImages, channelId: selection.channelId || null, model: selection.model },
      },
    });
    void text;
  };

  // 对外必须说**原样的** OpenAI 方言：dsh 与别的 OpenAI 客户端不认我们的 {success,data} 信封，
  // 所以这里自己写响应体，然后返回 __streamed 让分发层不要再套信封（这也是 index.js 约定的写法）。
  const effectiveModel = String(selection.model || requestedModel || '').trim() || 'platform-gateway';

  if (!stream) {
    try {
      const result = await provider.generate({ modality: 'TEXT', messages, model: body.model || undefined });
      const text = String(result?.assets?.[0]?.metadata?.text || '').trim();
      const usage = result?.usage || result?.assets?.find((asset) => asset?.metadata?.tokens)?.metadata?.tokens || null;
      record('SUCCESS', { text, usage });
      ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      ctx.res.end(JSON.stringify({
        id: completionId, object: 'chat.completion', created, model: effectiveModel,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: usage?.inputTokens || 0, completion_tokens: usage?.outputTokens || 0, total_tokens: (usage?.inputTokens || 0) + (usage?.outputTokens || 0) },
      }));
      return { __streamed: true };
    } catch (error) {
      const normalized = normalizeProviderError(error) || {};
      record('FAILED', { failCode: normalized.code || PROVIDER_ERROR_CODES.UNKNOWN });
      throw error;
    }
  }

  // 流式：说 OpenAI 的 SSE 方言（dsh 与大多数客户端都认这一套）
  const res = ctx.res;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  heartbeat.unref?.();
  let streamed = '';
  let usage = null;
  try {
    const result = await provider.generateStream({
      messages,
      model: body.model || undefined,
      onDelta: (delta) => {
        const piece = String(delta || '');
        if (!piece) return;
        streamed += piece;
        sseWrite(res, {
          id: completionId, object: 'chat.completion.chunk', created, model: effectiveModel,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        });
      },
    });
    usage = result?.usage || result?.assets?.find((asset) => asset?.metadata?.tokens)?.metadata?.tokens || null;
    const text = String(result?.assets?.[0]?.metadata?.text || streamed || '').trim();
    record('SUCCESS', { text, usage });
    sseWrite(res, { id: completionId, object: 'chat.completion.chunk', created, model: effectiveModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sseWrite(res, {
      id: completionId, object: 'chat.completion.chunk', created, model: effectiveModel, choices: [],
      usage: { prompt_tokens: usage?.inputTokens || 0, completion_tokens: usage?.outputTokens || 0, total_tokens: (usage?.inputTokens || 0) + (usage?.outputTokens || 0) },
    });
    sseWrite(res, '[DONE]');
  } catch (error) {
    const normalized = normalizeProviderError(error) || {};
    record('FAILED', { failCode: normalized.code || PROVIDER_ERROR_CODES.UNKNOWN });
    sseWrite(res, { error: { message: String(error?.message || '上游调用失败'), type: 'upstream_error', code: normalized.code || 'UPSTREAM_ERROR' } });
    sseWrite(res, '[DONE]');
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
  return { __streamed: true };
}
