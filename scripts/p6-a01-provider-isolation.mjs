import assert from 'node:assert/strict';
import { normalizeProviderError, PROVIDER_ERROR_CODES, unavailableProvider, validateProviderConfig } from '../apps/server/src/services/providerContract.js';

const mock = validateProviderConfig({ provider: 'local-mock', model: 'canvas-mock-v1' });
assert.equal(mock.valid, true);
const missing = validateProviderConfig({ provider: 'openai-compatible', model: 'gpt-test', endpoint: 'https://example.test/v1' });
assert.equal(missing.valid, false);
assert.ok(missing.reasons.includes('server-side API key is required'));
const valid = validateProviderConfig({ provider: 'openai-compatible', model: 'gpt-test', endpoint: 'https://example.test/v1', apiKey: 'secret-not-logged' });
assert.equal(valid.valid, true);
assert.equal(normalizeProviderError({ status: 429 }).code, PROVIDER_ERROR_CODES.RATE_LIMITED);
assert.equal(normalizeProviderError({ name: 'AbortError' }).code, PROVIDER_ERROR_CODES.TIMEOUT);
assert.equal(normalizeProviderError({ status: 503 }).code, PROVIDER_ERROR_CODES.UPSTREAM);
assert.equal(normalizeProviderError({ code: 'CONTENT_SAFETY_REJECTED' }).code, PROVIDER_ERROR_CODES.SAFETY_REJECTED);
const adapter = unavailableProvider({ name: 'openai-compatible', model: 'gpt-test', config: missing });
await assert.rejects(() => adapter.generate({ prompt: 'do not log this' }), (error) => error.code === PROVIDER_ERROR_CODES.CONFIG_INVALID);
console.log(JSON.stringify({ name: 'p6-a01-provider-isolation', pass: true, checks: 8 }));
