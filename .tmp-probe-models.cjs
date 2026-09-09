// 只读探测：看上游 /models 是否返回能力元数据（不打印密钥）。
const { readFileSync } = require('node:fs');
const { createDecipheriv, createHash } = require('node:crypto');

const SECRET_FILE = process.env.AI_PROVIDER_SECRET_FILE || '/etc/ai-kids-platform/provider-secrets.json';
const key = createHash('sha256').update(String(process.env.AUTH_PEPPER || 'p0-local-pepper')).digest();
const store = JSON.parse(readFileSync(SECRET_FILE, 'utf8'));
const decrypt = (x) => {
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(x.iv, 'hex'));
    d.setAuthTag(Buffer.from(x.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(x.data, 'base64')), d.final()]).toString('utf8');
  } catch { return ''; }
};
const secrets = store.secrets || {};
const seedanceKey = decrypt(secrets['channel-mtpzt0c8'] || secrets['channel-mtp9sht1'] || {});
const deepseekKey = decrypt(secrets['channel-mtp9razp'] || {});

const targets = [
  { label: 'seedance /models', url: 'https://api.seedance.nz/v1/models', apiKey: seedanceKey },
  { label: 'seedance /models/minimax-h3-i2v', url: 'https://api.seedance.nz/v1/models/minimax-h3-i2v', apiKey: seedanceKey },
  { label: 'deepseek /models', url: 'https://api.deepseek.com/v1/models', apiKey: deepseekKey },
];

(async () => {
  for (const target of targets) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(target.url, { headers: { authorization: `Bearer ${target.apiKey}`, accept: 'application/json' }, signal: controller.signal });
      clearTimeout(timer);
      const text = await response.text();
      console.log(JSON.stringify({ label: target.label, status: response.status, head: text.slice(0, 400) }));
    } catch (error) {
      console.log(JSON.stringify({ label: target.label, error: String(error.message || error).slice(0, 120) }));
    }
  }
})();
