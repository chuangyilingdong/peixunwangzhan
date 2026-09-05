import assert from 'node:assert/strict';
import { GENERATION_PROVIDER_CATALOG, GENERATION_PROVIDER_IDS, assertExternalAiAllowed, normalizeProviderError, PROVIDER_ERROR_CODES, validateProviderConfig, validateProviderRegistration } from '../apps/server/src/services/providerContract.js';

assert.equal(GENERATION_PROVIDER_IDS.has('custom'), true);
assert.equal(GENERATION_PROVIDER_IDS.has('openai-compatible'), true);
assert.equal(GENERATION_PROVIDER_IDS.has('zhipu'), true);
const registered = validateProviderRegistration({ provider: 'custom', model: 'custom-model', endpoint: 'https://api.example.test/v1' });
assert.equal(registered.valid, true);
const unregistered = validateProviderRegistration({ provider: 'not-approved', model: 'x', endpoint: 'https://api.example.test/v1' });
assert.equal(unregistered.valid, false);
const config = validateProviderConfig({ ...registered, apiKey: 'secret-not-logged' });
assert.equal(config.valid, true);
await assert.throws(() => assertExternalAiAllowed({ mode: 'adapter-required', role: 'STUDENT' }), (error) => error.code === 'STUDENT_EXTERNAL_AI_BLOCKED');
assert.doesNotThrow(() => assertExternalAiAllowed({ mode: 'adapter-required', allowStudentExternalContent: true, role: 'STUDENT' }));
assert.doesNotThrow(() => assertExternalAiAllowed({ mode: 'mock', role: 'STUDENT' }));
assert.equal(normalizeProviderError({ status: 400, message: 'content policy rejected' }).code, PROVIDER_ERROR_CODES.SAFETY_REJECTED);
console.log(JSON.stringify({ name: 'p6-a01-provider-catalog-isolation', pass: true, catalog: GENERATION_PROVIDER_CATALOG.length, checks: 13 }));
