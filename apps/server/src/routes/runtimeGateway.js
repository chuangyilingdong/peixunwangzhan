// 「学生运行时 → 平台网关」的入口（2026-09-16）
//
// 背景：学生端的 VibeCoding 改用 dsh（DeepSeek Harness）之后，模型调用要**继续走我们的网关**，
// 否则 token 用量与成本就从我们的账本里漏出去了。dsh 侧用 `llm-pi-ai` 的 hand-declared gateway
// 指向这里（`api: openai-completions` + `baseURL` + `apiKeyEnv`），所以这个端点说 OpenAI 兼容的话。
//
// 本文件提供两条端点（身份、门禁、记账三件事完全共用）：
//   · `handleRuntimeGateway`      —— `/api/gateway/v1/chat/completions`，OpenAI 兼容（聊天/agent 干活）；
//   · `handleRuntimeSearchGateway`（见 `runtimeSearchGateway.js`）—— `/api/gateway/v1/search/messages`，
//     Anthropic 协议**原样透传**（dsh 的网页搜索插件调的是 Anthropic Messages，不是搜索接口）。
//
// 三条硬要求（都在这里落地）：
//   ① 身份不是浏览器给的：运行时密钥是我们**签发**的（HMAC 签名，内含机构/学生/课时/课堂），
//      调用方改不了归属；密钥里没有的东西一律不认。
//   ② 每一通调用都重新过门禁：课堂必须仍在进行、学生仍在名单里。学生被移出名单或老师结束课堂后，
//      容器里即使还有密钥也调不动了（不用等容器回收）。
//   ③ 每一通调用都记账：与 VibeCoding 原来的链路完全同一套（算力池预算 → 渠道 → recordAiUsage）。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { errors, id, json, nowIso, q, row, arow } from '../lib.js';
import { AI_PROVIDER_API_KEY } from '../config.js';
import { getAiProviderPolicy } from './billingConfig.js';
import { providerSelectionForModality } from './aiGeneration.js';
import { generationProviderInfo, getGenerationProvider } from '../services/generationProvider.js';
import { getProviderApiKey } from '../services/providerSecret.js';
import { recordAiUsage } from '../services/creditUsage.js';
// VibeCoding「发送次数上限」：课时级设置 + 按学生的计数（见该文件头，与「算力额度只观测」是两套）
import { enforceVibecodingSendLimit } from '../services/vibecodingLessonSettings.js';
import { applyGatewayRoute } from '../services/computeGateway.js';
import { priceFenFor } from '../services/computePool.js';
import { assertExternalAiAllowed, normalizeProviderError, PROVIDER_ERROR_CODES } from '../services/providerContract.js';
import { createDsmlStripper, stripDsml } from '../services/dsmlFilter.js';

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

/**
 * 运行时密钥的校验。**导出**给搜索那条路复用：两条端点的身份必须同一套实现 ——
 * 这里各写一份的话，迟早出现「聊天验签、搜索不验签」这种洞（改一处忘一处）。
 */
export function verifyRuntimeKey(token) {
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
 *
 * 也导出给「拉起容器」那条路用（`services/studentRuntime.js`）：**开盒子与调模型是同一套门禁**，
 * 两处各写一份迟早会走偏（比如开盒子时只看课堂、不看名单）。
 */
export async function assertRuntimeClassroomActive(payload) {
  const session = await arow('SELECT id,org_id,lesson_id,status,teacher_id FROM class_sessions WHERE id=?', [payload.s]);
  if (!session || session.org_id !== payload.o) throw errors.forbidden('课堂不存在或不属于该机构', 'RUNTIME_CLASSROOM_UNAVAILABLE');
  if (session.status !== 'ACTIVE') throw errors.forbidden('课堂已经结束，创作环境已关闭', 'RUNTIME_CLASSROOM_INACTIVE');
  if (payload.l && session.lesson_id !== payload.l) throw errors.forbidden('课时与课堂不一致', 'RUNTIME_LESSON_MISMATCH');
  const part = await arow("SELECT status FROM session_students WHERE session_id=? AND student_id=? AND status='ACTIVE'", [session.id, payload.u]);
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

/**
 * 调用方把运行时密钥放在哪儿都认：`authorization: Bearer <key>` 或 `x-api-key: <key>`。
 * dsh 的聊天适配器走 Bearer，而它的**网页搜索插件两个都发**（源码里写死同时带 x-api-key 与
 * authorization）—— 所以两种都读，少读一种就等于「搜索永远 401」。
 * 放宽的只是**位置**，密钥本身照样要验签（见 verifyRuntimeKey）。
 */
export function readRuntimeToken(ctx) {
  const apiKey = String(ctx.req?.headers?.['x-api-key'] || '').trim();
  return apiKey || readBearer(ctx);
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
  let messages = raw
    .map((item) => {
      const message = {
        role: ['system', 'user', 'assistant', 'tool'].includes(String(item?.role)) ? String(item.role) : 'user',
        content: normalizeContentParts(item?.content),
      };
      // 工具调用（2026-09-16 打通）—— 这三样以前**全被丢掉**，工具链路在网关这一跳就断了：
      //   · assistant 消息上的 tool_calls：模型上一轮请求调用了什么；
      //   · tool 消息上的 tool_call_id：这是哪一次调用的结果（少了它上游对不上号）；
      //   · name：客户端有时用它标工具名。
      if (Array.isArray(item?.tool_calls) && item.tool_calls.length) message.tool_calls = item.tool_calls;
      if (item?.tool_call_id) message.tool_call_id = String(item.tool_call_id);
      if (item?.name && message.role === 'tool') message.name = String(item.name);
      return message;
    })
    // ⚠️ 过滤条件必须放过「只有工具调用/只有工具结果、没有正文」的消息：
    //    assistant 的 tool_calls 消息 content 是空的，tool 结果也可能为空 ——
    //    老条件是「content 非空」，会把它们整条筛掉，于是模型的调用与结果对不上。
    .filter((item) => item.tool_calls || item.tool_call_id
      || (typeof item.content === 'string' ? item.content.trim() !== '' : item.content.length > 0));
  if (!messages.length) throw errors.badRequest('messages 不能为空', 'VALIDATION_REQUIRED');
  // ⚠️ 截断必须**保住工具调用的配对**（2026-09-16 实测踩到）：
  // 上游要求「带 tool_calls 的 assistant 消息后面必须紧跟对应的工具结果」。
  // agent 干活时历史里全是这种成对消息（一次任务几十轮 Bash），从中间 `slice(-40)` 切开，
  // 开头就会剩下一堆「孤儿工具结果」，上游直接拒 → 学生看到「AI 供应商调用失败」。
  // 所以切完之后要把开头的孤儿 tool 消息丢掉（它的 assistant 已经被切走了）。
  const MAX_HISTORY = 40;
  if (messages.length > MAX_HISTORY) {
    let start = messages.length - MAX_HISTORY;
    while (start < messages.length && messages[start].role === 'tool') start += 1;
    // 兜底：万一丢光了（极端情况：一整段全是工具结果），至少留最后一条
    messages = start >= messages.length ? messages.slice(-1) : messages.slice(start);
  }
  return boundHistoryImages(messages);
}

/**
 * 历史里的图片按**字节**封顶（2026-09-17 实测踩到）。
 *
 * 为什么需要：dsh 每轮把整段对话重发一次，而 agent 干活时会**不停地读自己的截图**
 * （「读取图片」→ 图片作为内容块进历史）。图片按**字节**很大、按 **token** 很小 ——
 * 学生那一轮读了 8 张截图，账本上只有 25k tokens，请求体却轻松超过 2MB，
 * 于是整轮被 `PAYLOAD_TOO_LARGE` 掐掉、活干到一半停住。
 *
 * 这个上限是**安全阀**，不是常规行为：常规会话（十几张截图）根本碰不到它。
 * 真的碰到了就从**最新**往回留（越近的截图越可能是模型正在看的），更早的换成一句话 ——
 * 并且**告诉它图在哪儿**：这些图是 agent 自己从工作区读的（`/tmp/xxx.png` 之类），需要时再读一次即可，
 * 所以省略不会让它丢掉信息，只会多一次读文件。
 *
 * 只换图片那一块，**消息本身与 tool_call_id 都不动** —— 工具调用的配对不能因为省略图片而散掉。
 */
const MAX_HISTORY_IMAGE_CHARS = 12_000_000; // 约 9MB 的图片（base64 后）：与下面的分发层上限留足余量
const ELIDED_IMAGE_NOTE = '（更早的一张截图已省略：需要时请重新读取工作区里的那个图片文件）';

function boundHistoryImages(messages) {
  let budget = MAX_HISTORY_IMAGE_CHARS;
  let elided = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index].content;
    if (!Array.isArray(content)) continue;
    const parts = [];
    for (const part of content) {
      if (part?.type !== 'image_url') { parts.push(part); continue; }
      const size = String(part.image_url?.url || '').length;
      if (size <= budget) { budget -= size; parts.push(part); continue; }
      parts.push({ type: 'text', text: ELIDED_IMAGE_NOTE });
      elided += 1;
    }
    // 理论上不会空（省略时补了文字），兜底一下免得交给上游一个空 content 数组
    messages[index].content = parts.length ? parts : [{ type: 'text', text: ELIDED_IMAGE_NOTE }];
  }
  if (elided) console.warn(`[runtimeGateway] 历史图片超预算，省略了 ${elided} 张（上限 ${MAX_HISTORY_IMAGE_CHARS} 字符）—— 模型需要时可以重新读文件`);
  return messages;
}

// 给守卫脚本直接断言这几个纯函数（它们决定「学生的图有没有被压扁」、名字解析到哪条渠道、
// 以及搜索要打到哪里 —— 都是**纯函数**，能脱离网络断言，所以守卫钉的是真逻辑而不是文案）。
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

/**
 * 网页搜索要打的**完整** Anthropic Messages 地址。
 *
 * 为什么搜索不能沿用聊天那条路：dsh 的搜索插件（`@deepseek-ai/dsh-web-search-deepseek`）
 * 调的是 **Anthropic 协议的 `/messages`**（`const endpoint = `${options.baseURL}/messages``），
 * 搜索是「模型一跳里的服务端工具 `web_search_20250305`」，**不是**一个搜索接口。
 * 插件自己的注释写明：它复用 `DEEPSEEK_API_KEY`，但**不复用** chat 的 base（`$DEEPSEEK_BASE_URL`）。
 * 所以这两条路的 base 本来就不是同一个，不能拿聊天的 endpoint 直接当搜索的 endpoint。
 *
 * 三种渠道各推各的（都用渠道自己配的东西，不写死任何一家）：
 *   · 走了算力网关（new-api）→ 网关自己的 `/v1/messages`；
 *   · 渠道 `protocol=ANTHROPIC` → 它的 endpoint 就是 Anthropic 基地址；
 *   · 其余（上游是 DeepSeek 官方那类 OpenAI 兼容口）→ 取**同源主机**的 `/anthropic/v1/messages`。
 *     （DeepSeek 官方就是这个形状：chat 在 `api.deepseek.com`，Anthropic 口在
 *      `api.deepseek.com/anthropic/v1`，**同一把密钥**。已实测：拿我们渠道里现成的 key
 *      打这条口能返回真实的 `web_search_tool_result`。）
 */
export function searchUpstreamEndpoint({ endpoint, protocol = '', viaGateway = false } = {}) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!base) throw errors.conflict('没有可用的搜索上游端点，请让管理员检查渠道配置', 'RUNTIME_SEARCH_ENDPOINT_MISSING');
  let origin = '';
  try { origin = new URL(base).origin; } catch { throw errors.conflict(`搜索上游端点不是完整地址：${base}`, 'RUNTIME_SEARCH_ENDPOINT_INVALID'); }
  // 渠道把完整地址配到头了（以 /messages 结尾）就照用，别再拼一层
  if (/\/messages$/i.test(base)) return base;
  if (viaGateway) return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  if (String(protocol).toUpperCase() === 'ANTHROPIC') return `${base}/messages`;
  return `${origin}/anthropic/v1/messages`;
}

/**
 * 搜索这条路「走哪条渠道、用哪个模型」——**不碰凭证，也不管网关**（这两件事各由下面一个函数与本函数组合）。
 *
 * 与聊天那条路同一个规矩（见 `resolveRuntimeSelection` 的注释）：**调用方报的模型名只当意向**，
 * 在我们自己渠道的可用模型清单里认得出就用它，认不出就用这条渠道自己的模型 ——
 * 绝不把调用方给的字符串原样发给上游（轻则上游 400，重则按另一个模型计费）。
 * （实测 `deepseek-v4-flash`（插件默认）与 `deepseek-flash`（我们渠道的）上游都认，
 *   但规矩不能因为「这次恰好认」就破。）
 */
export function searchChannelSelection(policy, requestedModel = '') {
  const base = providerSelectionForModality(policy, 'TEXT', '');
  const channel = channelById(policy, base.channelId);
  const model = modelForChannel(channel, requestedModel) || base.model;
  return {
    channel,
    selection: { ...base, model, estimatedCostFen: channel?.modelCosts?.[model] ?? channel?.estimatedCostFen ?? null },
  };
}

/**
 * 搜索这一跳「打哪个地址、用哪把真密钥」——按**最终真正要打的那一跳**算：
 * 过了算力网关就是网关自己，没过就是渠道上游。
 *
 * 真密钥在这里解析出来、**只在这一跳用**，绝不进学生环境 —— 网页搜索必须走网关的原因就是它：
 * 密钥一旦导出，学生能从自己的进程里读出来，既泄漏又能绕过账本花钱；走网关则学生手里只有
 * 一把短时的、绑课堂的运行时密钥（`verifyRuntimeKey` 验的就是它）。
 * 取值顺序与聊天那条路的 `providerConfig` 完全一致（网关令牌 > 渠道密钥 > 默认密钥）。
 */
export function searchUpstreamCredentials(channel, selection = {}) {
  const endpoint = searchUpstreamEndpoint({
    endpoint: selection.gateway?.endpoint || channel?.endpoint,
    protocol: channel?.protocol || '',
    viaGateway: Boolean(selection.gateway),
  });
  const apiKey = String(selection.gateway?.apiKey || getProviderApiKey(channel?.id) || getProviderApiKey() || AI_PROVIDER_API_KEY || '').trim();
  if (!apiKey) throw errors.conflict('搜索渠道没有配置密钥，请让管理员检查渠道设置', 'RUNTIME_SEARCH_KEY_MISSING');
  return { endpoint, apiKey };
}

export async function handleRuntimeGateway(ctx) {
  const path = String(ctx.pathname || '');
  if (path !== '/api/gateway/v1/chat/completions' || ctx.method !== 'POST') return null;

  const payload = verifyRuntimeKey(readRuntimeToken(ctx));
  const session = await assertRuntimeClassroomActive(payload);
  const body = ctx.body || {};
  const messages = normalizeMessages(body);
  const stream = body.stream === true;

  // VibeCoding 发送次数上限（2026-09-19 用户口径，机制见 services/vibecodingLessonSettings.js）。
  // ⚠️ 位置有意放在**打上游之前**：超限的这一次既不花算力、也不进用量账，学生当场拿到原因。
  // ⚠️ 这节课没配上限时 `allowed` 恒为 true（不填 = 不拦），所以没人配置时现状一字不改。
  const sendGate = await enforceVibecodingSendLimit({ sessionId: session.id, studentId: payload.u, lessonId: session.lesson_id || '', messages });
  if (!sendGate.allowed) {
    // 对外仍要说 OpenAI 方言（dsh 只认这个），客户端把 message 原样显示给学生
    ctx.res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    ctx.res.end(JSON.stringify({
      error: {
        message: `这节课的发送次数用完了（共 ${sendGate.limit} 次）。先把自己的想法写下来，或者请老师再开一次课堂。`,
        type: 'send_limit_exceeded',
        code: 'SEND_LIMIT_EXCEEDED',
      },
    }));
    return { __streamed: true };
  }

  const policy = await getAiProviderPolicy();
  const requestedModel = String(body.model || '').trim();
  const withImages = hasImageParts(messages);
  // 渠道选择与预算检查与 VibeCoding 原链路同一套：机构/学生/课时/课堂四个维度都带上。
  // 带图的请求默认**跟着模型走**（同一条 TEXT 渠道），配了「读图渠道」才改走那条。
  const selection = await applyGatewayRoute(
    resolveRuntimeSelection(policy, requestedModel, withImages),
    { orgId: payload.o, studentId: payload.u, lessonId: session.lesson_id || '', modality: 'TEXT' },
  );
  // 预算检查是**提示性**的（enforced 恒为 false，见 computePool 注释）：课时金额超了只提醒平台，不阻断学生生成
  const provider = getGenerationProvider(selection);
  const providerInfo = generationProviderInfo(selection);
  assertExternalAiAllowed({ mode: providerInfo.mode, allowStudentExternalContent: policy.allowStudentExternalContent });

  const completionId = `chatcmpl-${id('rt')}`;
  const created = Math.floor(Date.now() / 1000);
  const record = async (status, { text = '', usage = null, failCode = null, providerName = provider.name } = {}) => {
    await recordAiUsage({
      orgId: payload.o, userId: payload.u, sessionId: session.id,
      modality: 'TEXT', model: selection.model, status, failCode,
      inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0,
      costFen: provider.compute?.saleSnapshot?.unitFen ?? await priceFenFor({ modality: 'TEXT', model: selection.model }),
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

  // 客户端带来的工具定义：**必须原样转发**，否则模型没有工具通道，只能把调用写进正文
  // （DSML 标记 → 学生看到「AI 说一句就停」）。
  // ⚠️ 必须声明在**流式与非流式两个分支之前**：我第一版放在流式分支里，
  //    非流式那条路会踩暂时性死区（ReferenceError → 500），被 p97 当场抓住。
  const tools = Array.isArray(body?.tools) && body.tools.length ? body.tools : null;
  const toolChoice = body?.tool_choice ?? null;

  if (!stream) {
    try {
      const result = await provider.generate({ modality: 'TEXT', messages, model: body.model || undefined, tools, toolChoice });
      // 同流式：上游把工具调用当正文吐出来时（DSML），别原样交给客户端。
      const text = stripDsml(String(result?.assets?.[0]?.metadata?.text || '').trim());
      const usage = result?.usage || result?.assets?.find((asset) => asset?.metadata?.tokens)?.metadata?.tokens || null;
      await record('SUCCESS', { text, usage });
      ctx.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      ctx.res.end(JSON.stringify({
        id: completionId, object: 'chat.completion', created, model: effectiveModel,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: usage?.inputTokens || 0, completion_tokens: usage?.outputTokens || 0, total_tokens: (usage?.inputTokens || 0) + (usage?.outputTokens || 0) },
      }));
      return { __streamed: true };
    } catch (error) {
      const normalized = normalizeProviderError(error) || {};
      await record('FAILED', { failCode: normalized.code || PROVIDER_ERROR_CODES.UNKNOWN });
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
  // 止血：上游把工具调用当正文吐出来（DSML 标记）时，别让学生看见乱码。
  // 真正的修法是打通 tools / tool_calls —— 见 services/dsmlFilter.js 的文件头注释。
  let dsmlStripped = 0;
  const dsml = createDsmlStripper({ onStrip: (chars) => { dsmlStripped += chars; } });
  // 这一轮里上游有没有返回工具调用 —— 决定最后那个分片的 finish_reason。
  let sawToolCalls = false;
  try {
    const result = await provider.generateStream({
      messages,
      model: body.model || undefined,
      tools,
      toolChoice,
      // 工具调用：按 OpenAI 方言原样转给客户端（dsh 就是靠这个才知道该去执行什么）。
      // ⚠️ 这条**不能**过 DSML 过滤器 —— 它要的就是结构化字段，不是正文。
      onToolCalls: (toolCallDelta, finishReason) => {
        sawToolCalls = true;
        sseWrite(res, {
          id: completionId, object: 'chat.completion.chunk', created, model: effectiveModel,
          choices: [{ index: 0, delta: { tool_calls: toolCallDelta }, finish_reason: finishReason || null }],
        });
      },
      onDelta: (delta) => {
        const piece = dsml.push(delta);
        if (!piece) return;
        streamed += piece;
        sseWrite(res, {
          id: completionId, object: 'chat.completion.chunk', created, model: effectiveModel,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        });
      },
    });
    const tail = dsml.flush();
    if (tail) {
      streamed += tail;
      sseWrite(res, {
        id: completionId, object: 'chat.completion.chunk', created, model: effectiveModel,
        choices: [{ index: 0, delta: { content: tail }, finish_reason: null }],
      });
    }
    usage = result?.usage || result?.assets?.find((asset) => asset?.metadata?.tokens)?.metadata?.tokens || null;
    const text = String(result?.assets?.[0]?.metadata?.text || streamed || '').trim();
    await record('SUCCESS', { text, usage });
    // 留个痕：这段被摘掉了多少字符。它持续大于 0 就说明上游还在拿工具调用当正文，
    // 那时要去看「打通 tools / tool_calls」这件事（本过滤只是止血）。
    if (dsmlStripped) console.warn(`[runtimeGateway] 摘掉工具调用标记 ${dsmlStripped} 字符（模型 ${effectiveModel}）`);
    sseWrite(res, { id: completionId, object: 'chat.completion.chunk', created, model: effectiveModel, choices: [{ index: 0, delta: {}, finish_reason: sawToolCalls ? 'tool_calls' : 'stop' }] });
    sseWrite(res, {
      id: completionId, object: 'chat.completion.chunk', created, model: effectiveModel, choices: [],
      usage: { prompt_tokens: usage?.inputTokens || 0, completion_tokens: usage?.outputTokens || 0, total_tokens: (usage?.inputTokens || 0) + (usage?.outputTokens || 0) },
    });
    sseWrite(res, '[DONE]');
  } catch (error) {
    const normalized = normalizeProviderError(error) || {};
    await record('FAILED', { failCode: normalized.code || PROVIDER_ERROR_CODES.UNKNOWN });
    sseWrite(res, { error: { message: String(error?.message || '上游调用失败'), type: 'upstream_error', code: normalized.code || 'UPSTREAM_ERROR' } });
    sseWrite(res, '[DONE]');
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
  return { __streamed: true };
}
