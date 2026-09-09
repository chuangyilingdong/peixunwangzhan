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
  const labels = { TEXT: '灵感提示词', IMAGE: '画面素材', MUSIC: '音乐素材', VIDEO: '短片素材', PODCAST: '播客素材', DUBBING: '配音素材' };
  const mockText = (prompt) => `这是本地模拟回复。\n\n你说的是：${String(prompt || '').slice(0, 200)}\n\n\`\`\`js\nconsole.log('hello from mock');\n\`\`\`\n`;
  return {
    name: 'local-mock',
    // 如实回报被请求的模型，便于验证「课时指定模型」这类覆盖是否生效
    model,
    capabilities: ['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING'],
    async generate({ modality, prompt, title }) {
      const label = title || labels[modality] || '创作素材';
      const hue = [...String(prompt)].reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
      const metadata = { mock: true, modality, prompt };
      if (modality === 'TEXT') metadata.text = mockText(prompt);
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
      const text = mockText(prompt || lastUser?.content || '');
      let full = '';
      for (const chunk of text.match(/[\s\S]{1,24}/g) || [text]) {
        full += chunk;
        if (typeof onDelta === 'function') onDelta(chunk, full);
      }
      return { assets: [{ label: 'AI 回复', mimeType: 'text/plain; charset=utf-8', assetUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`, metadata: { mock: true, modality: 'TEXT', text } }], streamed: true };
    },
  };
}

function providerSelection({ provider, model, endpoint, channelId, requestTemplates } = {}) {
  return {
    provider: String(provider || AI_PROVIDER).trim(),
    model: String(model || AI_PROVIDER_MODEL).trim(),
    endpoint: String(endpoint || AI_PROVIDER_ENDPOINT).trim(),
    channelId: String(channelId || 'default').trim(),
    requestTemplates: requestTemplates && typeof requestTemplates === 'object' ? requestTemplates : {},
  };
}

export function providerConfig(selection = {}) {
  const selected = providerSelection(selection);
  return validateProviderConfig({ ...selected, apiKey: getProviderApiKey(selected.channelId) || getProviderApiKey() || AI_PROVIDER_API_KEY });
}
export function generationProviderInfo(selection = {}) {
  const config = providerConfig(selection);
  const definition = providerDefinition(config.provider);
  const adapterAvailable = isMockProvider(config.provider) || Boolean(definition?.adapterAvailable);
  const capabilities = isMockProvider(config.provider) ? ['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING'] : (adapterAvailable ? ['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING'] : []);
  return {
    provider: config.provider,
    model: config.model,
    mode: isMockProvider(config.provider) ? 'mock' : adapterAvailable ? 'external-adapter' : 'adapter-required',
    configured: config.valid,
    adapterAvailable,
    capabilities,
    endpointConfigured: Boolean(config.endpoint),
    configError: config.reasons.length ? 'AI_PROVIDER_CONFIG_INVALID' : null,
  };
}
export function getGenerationProvider(selection = {}) {
  const selected = providerSelection(selection);
  const config = providerConfig(selected);
  if (isMockProvider(config.provider)) return mockProvider(config.model);
  const definition = providerDefinition(config.provider);
  if (!config.valid || !definition?.adapterAvailable) return unavailableProvider({ name: config.provider, model: config.model, config });
  return openAiCompatibleProvider({ name: config.provider, model: config.model, endpoint: config.endpoint, apiKey: getProviderApiKey(selected.channelId) || getProviderApiKey() || AI_PROVIDER_API_KEY, modalityEndpoints: AI_PROVIDER_MODALITY_ENDPOINTS, pollIntervalMs: AI_PROVIDER_POLL_INTERVAL_MS, voice: AI_PROVIDER_VOICE, requestTemplates: selected.requestTemplates });
}
