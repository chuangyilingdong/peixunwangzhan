import { AI_PROVIDER, AI_PROVIDER_ENDPOINT, AI_PROVIDER_MODEL, AI_PROVIDER_API_KEY, AI_PROVIDER_MODALITY_ENDPOINTS, AI_PROVIDER_POLL_INTERVAL_MS, AI_PROVIDER_VOICE } from '../config.js';
import { isMockProvider, providerDefinition, unavailableProvider, validateProviderConfig } from './providerContract.js';
import { openAiCompatibleProvider } from './openaiCompatibleProvider.js';

function svgDataUrl(title, subtitle, hue) {
  const escape = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="hsl(${hue} 75% 52%)"/><stop offset="1" stop-color="hsl(${(hue + 58) % 360} 78% 66%)"/></linearGradient></defs><rect width="960" height="540" fill="url(#g)"/><circle cx="800" cy="115" r="90" fill="#fff" opacity=".25"/><text x="72" y="240" fill="#fff" font-family="Arial, sans-serif" font-size="56" font-weight="700">${escape(title)}</text><text x="72" y="310" fill="#fff" font-family="Arial, sans-serif" font-size="30">${escape(subtitle).slice(0, 46)}</text><text x="72" y="450" fill="#fff" opacity=".85" font-family="Arial, sans-serif" font-size="22">AI 魔法学院 · 本地模拟素材</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function mockProvider() { return { name: 'local-mock', model: AI_PROVIDER_MODEL, capabilities: ['TEXT', 'IMAGE', 'MUSIC', 'VIDEO', 'PODCAST', 'DUBBING'], async generate({ modality, prompt, title }) { const labels = { TEXT: '灵感提示词', IMAGE: '画面素材', MUSIC: '音乐素材', VIDEO: '短片素材', PODCAST: '播客素材', DUBBING: '配音素材' }; const label = title || labels[modality] || '创作素材'; const hue = [...String(prompt)].reduce((total, char) => total + char.charCodeAt(0), 0) % 360; return { assets: [{ label, mimeType: modality === 'IMAGE' ? 'image/svg+xml' : 'application/x-ai-kids-mock', assetUrl: `mock://generation/${Date.now().toString(36)}`, previewUrl: svgDataUrl(label, prompt, hue), metadata: { mock: true, modality, prompt } }] }; } }; }

function providerSelection({ provider, model, endpoint } = {}) {
  return {
    provider: String(provider || AI_PROVIDER).trim(),
    model: String(model || AI_PROVIDER_MODEL).trim(),
    endpoint: String(endpoint || AI_PROVIDER_ENDPOINT).trim(),
  };
}

export function providerConfig(selection = {}) {
  const selected = providerSelection(selection);
  return validateProviderConfig({ ...selected, apiKey: AI_PROVIDER_API_KEY });
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
  const config = providerConfig(selection);
  if (isMockProvider(config.provider)) return mockProvider();
  const definition = providerDefinition(config.provider);
  if (!config.valid || !definition?.adapterAvailable) return unavailableProvider({ name: config.provider, model: config.model, config });
  return openAiCompatibleProvider({ name: config.provider, model: config.model, endpoint: config.endpoint, apiKey: AI_PROVIDER_API_KEY, modalityEndpoints: AI_PROVIDER_MODALITY_ENDPOINTS, pollIntervalMs: AI_PROVIDER_POLL_INTERVAL_MS, voice: AI_PROVIDER_VOICE });
}
