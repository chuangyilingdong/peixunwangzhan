import { AI_PROVIDER, AI_PROVIDER_ENDPOINT, AI_PROVIDER_MODEL, AI_PROVIDER_API_KEY, AI_PROVIDER_MODALITY_ENDPOINTS, AI_PROVIDER_POLL_INTERVAL_MS, AI_PROVIDER_VOICE } from '../config.js';
import { isMockProvider, providerDefinition, unavailableProvider, validateProviderConfig } from './providerContract.js';
import { openAiCompatibleProvider } from './openaiCompatibleProvider.js';
import { getProviderApiKey } from './providerSecret.js';

function svgDataUrl(title, subtitle, hue) {
  const escape = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="hsl(${hue} 75% 52%)"/><stop offset="1" stop-color="hsl(${(hue + 58) % 360} 78% 66%)"/></linearGradient></defs><rect width="960" height="540" fill="url(#g)"/><circle cx="800" cy="115" r="90" fill="#fff" opacity=".25"/><text x="72" y="240" fill="#fff" font-family="Arial, sans-serif" font-size="56" font-weight="700">${escape(title)}</text><text x="72" y="310" fill="#fff" font-family="Arial, sans-serif" font-size="30">${escape(subtitle).slice(0, 46)}</text><text x="72" y="450" fill="#fff" opacity=".85" font-family="Arial, sans-serif" font-size="22">AI 魔法学院 · 本地模拟素材</text></svg>`;
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

export function providerSelection({ provider, model, endpoint, channelId, requestTemplates, modelRequestTemplates, requestPaths, pollPaths, gateway, apiKey } = {}) {
  return {
    provider: String(provider || AI_PROVIDER).trim(),
    model: String(model || AI_PROVIDER_MODEL).trim(),
    endpoint: String(endpoint || AI_PROVIDER_ENDPOINT).trim(),
    channelId: String(channelId || 'default').trim(),
    requestTemplates: requestTemplates && typeof requestTemplates === 'object' ? requestTemplates : {},
    modelRequestTemplates: modelRequestTemplates && typeof modelRequestTemplates === 'object' ? modelRequestTemplates : {},
    requestPaths: requestPaths && typeof requestPaths === 'object' ? requestPaths : {},
    pollPaths: pollPaths && typeof pollPaths === 'object' ? pollPaths : {},
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
  const selected = providerSelection(selection);
  const config = providerConfig(selected);
  if (isMockProvider(config.provider)) return mockProvider(config.model);
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
  return openAiCompatibleProvider({ name: config.provider, model: config.model, endpoint: config.endpoint, apiKey: selected.apiKey || getProviderApiKey(selected.channelId) || getProviderApiKey() || AI_PROVIDER_API_KEY, modalityEndpoints: AI_PROVIDER_MODALITY_ENDPOINTS, pollIntervalMs: AI_PROVIDER_POLL_INTERVAL_MS, voice: AI_PROVIDER_VOICE, requestTemplates: selected.requestTemplates, modelRequestTemplates: selected.modelRequestTemplates, requestPaths: selected.requestPaths, pollPaths: selected.pollPaths });
}
