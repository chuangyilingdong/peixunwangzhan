import { AI_PROVIDER, AI_PROVIDER_ENDPOINT, AI_PROVIDER_MODEL } from '../config.js';

function svgDataUrl(title, subtitle, hue) {
  const escape = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="hsl(${hue} 75% 52%)"/><stop offset="1" stop-color="hsl(${(hue + 58) % 360} 78% 66%)"/></linearGradient></defs><rect width="960" height="540" fill="url(#g)"/><circle cx="800" cy="115" r="90" fill="#fff" opacity=".25"/><text x="72" y="240" fill="#fff" font-family="Arial, sans-serif" font-size="56" font-weight="700">${escape(title)}</text><text x="72" y="310" fill="#fff" font-family="Arial, sans-serif" font-size="30">${escape(subtitle).slice(0, 46)}</text><text x="72" y="450" fill="#fff" opacity=".85" font-family="Arial, sans-serif" font-size="22">AI 魔法学院 · 本地模拟素材</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function mockProvider() {
  return {
    name: 'local-mock', model: AI_PROVIDER_MODEL,
    async generate({ modality, prompt, title }) {
      const labels = { TEXT: '灵感提示词', IMAGE: '画面素材', MUSIC: '音乐素材', VIDEO: '短片素材', PODCAST: '播客素材', DUBBING: '配音素材' };
      const label = title || labels[modality] || '创作素材';
      const hue = [...String(prompt)].reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
      const previewUrl = svgDataUrl(label, prompt, hue);
      return { assets: [{ label, mimeType: modality === 'IMAGE' ? 'image/svg+xml' : 'application/x-ai-kids-mock', assetUrl: `mock://generation/${Date.now().toString(36)}`, previewUrl, metadata: { mock: true, modality, prompt } }] };
    },
  };
}

export function generationProviderInfo() {
  const mock = ['local-mock', 'mock', ''].includes(AI_PROVIDER.toLowerCase());
  return { provider: mock ? 'local-mock' : AI_PROVIDER, model: AI_PROVIDER_MODEL, mode: mock ? 'mock' : 'adapter-required', configured: mock, endpointConfigured: Boolean(AI_PROVIDER_ENDPOINT) };
}

export function getGenerationProvider() {
  if (['local-mock', 'mock', ''].includes(AI_PROVIDER.toLowerCase())) return mockProvider();
  return { name: AI_PROVIDER, model: AI_PROVIDER_MODEL, async generate() { const error = new Error('当前 AI 供应商适配器尚未安装，请配置本地 mock 或接入对应 provider adapter。'); error.code = 'GENERATION_PROVIDER_UNAVAILABLE'; throw error; } };
}
