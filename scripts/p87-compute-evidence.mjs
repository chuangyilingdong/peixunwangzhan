import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'p87-compute-evidence-'));
process.env.PLATFORM_DB_PATH = path.join(temp, 'test.db');
process.env.PLATFORM_DATA_DIR = temp;
process.env.AI_PROVIDER_API_KEY = 'p87-secret';

const { getGenerationProvider } = await import('../apps/server/src/services/generationProvider.js');
const { recordAiUsage } = await import('../apps/server/src/services/creditUsage.js');
const { handleAdmin } = await import('../apps/server/src/routes/adminOrg.js');
const { q, row, arow, aq } = await import('../apps/server/src/lib.js');
const originalFetch = globalThis.fetch;
const selection = {
  provider: 'custom', model: 'evidence-model', endpoint: 'https://gateway.test/v1', channelId: 'configured-channel',
  providerAccountRef: 'supplier-account-87',
  apiKey: 'p87-secret', estimatedCostFen: 17,
  gateway: { endpoint: 'https://gateway.test', apiKey: 'p87-secret', tokenName: 'internal-v2/机构:o/学生:u' },
};
const auth = { user: { id: 'root', login: 'root', role: 'SUPER_ADMIN', permissions: [] }, rawUser: { permissions: '[]' } };
const adminCtx = (query = '') => ({ pathname: '/api/admin/compute-attempts', method: 'GET', body: {}, auth, search: new URLSearchParams(query), req: { socket: { remoteAddress: '127.0.0.1' } } });

try {
  globalThis.fetch = async (_url, options = {}) => new Response(JSON.stringify({ id: 'sync-payload-87', usage: { id: 'sync-usage-87' }, choices: [{ message: { content: 'sync ok' } }] }), {
    headers: { 'content-type': 'application/json', 'x-request-id': 'sync-request-87' },
  });
  const syncProvider = getGenerationProvider({ ...selection, gateway: null });
  await syncProvider.generate({ modality: 'TEXT', prompt: 'sync' });
  const syncAttempt = await arow('SELECT * FROM compute_attempts WHERE call_id=?', [syncProvider.compute.callId]);
  assert.ok(syncAttempt.client_request_id.startsWith('req_'));
  assert.equal(syncAttempt.response_request_id, 'sync-request-87');
  assert.equal(syncAttempt.response_payload_id, 'sync-payload-87');
  assert.equal(syncAttempt.usage_id, 'sync-usage-87');

  let streamRequestId = '';
  globalThis.fetch = async (_url, options = {}) => {
    streamRequestId = options.headers?.['x-client-request-id'];
    return new Response('data: {"id":"stream-payload-87","usage":{"id":"stream-usage-87"},"choices":[{"delta":{"content":"stream ok"}}]}\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream', 'request-id': 'stream-request-87' },
    });
  };
  const streamProvider = getGenerationProvider({ ...selection, gateway: null });
  await streamProvider.generateStream({ messages: [{ role: 'user', content: 'stream' }] });
  const streamAttempt = await arow('SELECT * FROM compute_attempts WHERE call_id=?', [streamProvider.compute.callId]);
  assert.equal(streamRequestId, streamAttempt.client_request_id);
  assert.equal(streamAttempt.response_request_id, 'stream-request-87');
  assert.equal(streamAttempt.response_payload_id, 'stream-payload-87');
  assert.equal(streamAttempt.usage_id, 'stream-usage-87');

  let sentClientRequestId = '';
  let pollClientRequestId = '';
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === 'GET') {
      pollClientRequestId = options.headers?.['x-client-request-id'];
      return new Response(JSON.stringify({ id: 'final-payload', usage: { id: 'usage-87' }, data: [{ url: 'https://asset.test/video.mp4' }] }), {
        headers: { 'content-type': 'application/json', 'request-id': 'poll-request-87', 'x-gateway-log-id': 'gateway-log-87', 'x-channel-id': 'actual-channel-87' },
      });
    }
    sentClientRequestId = options.headers?.['x-client-request-id'];
    return new Response(JSON.stringify({ id: 'task-87', task_id: 'task-87' }), {
      headers: { 'content-type': 'application/json', 'x-request-id': 'submit-request-87' },
    });
  };

  const provider = getGenerationProvider(selection);
  await provider.generate({ modality: 'VIDEO', prompt: 'test', title: 'evidence' });
  const attempt = await arow('SELECT * FROM compute_attempts WHERE call_id=?', [provider.compute.callId]);
  assert.ok(attempt.client_request_id.startsWith('req_'));
  assert.equal(sentClientRequestId, attempt.client_request_id);
  assert.equal(pollClientRequestId, attempt.client_request_id);
  assert.equal(attempt.response_request_id, 'poll-request-87');
  assert.equal(attempt.response_payload_id, 'final-payload');
  assert.equal(attempt.usage_id, 'usage-87');
  assert.equal(attempt.task_id, 'task-87');
  assert.equal(attempt.gateway_log_id, 'gateway-log-87');
  assert.equal(attempt.actual_channel_id, 'actual-channel-87');
  assert.equal(attempt.provider_account_ref, 'supplier-account-87');
  await aq('INSERT INTO organizations(id,name,status,contract_start_at,contract_expires_at,is_trial,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', ['org-87', 'P87 Org', 'ACTIVE', new Date().toISOString(), new Date(Date.now() + 86400000).toISOString(), 0, new Date().toISOString(), new Date().toISOString()]);
  await recordAiUsage({ orgId: 'org-87', userId: 'user-87', modality: 'VIDEO', model: 'evidence-model', status: 'SUCCESS', pricing: { compute: provider.compute } });
  const linkedAttempt = await arow('SELECT * FROM compute_attempts WHERE id=?', [attempt.id]);
  assert.ok(linkedAttempt.internal_usage_record_id?.startsWith('usage_'));
  assert.equal(linkedAttempt.usage_id, 'usage-87', 'provider usage ID must remain upstream evidence');
  assert.equal((await arow('SELECT compute_call_id FROM usage_records WHERE id=?', [linkedAttempt.internal_usage_record_id])).compute_call_id, attempt.call_id);
  // 2026-09-18 口径变更（不是测试漂移）：渠道卡手填的「估算成本」（estimatedCostFen / modelCosts）
  // 已从成本取值链移除，快照的 basis 从 CONFIGURED_ESTIMATE 变成 UPSTREAM_REPORTED_OR_UNKNOWN，
  // estimatedCostFen 恒为 null。这条**故意保留**夹具里的 estimatedCostFen: 17 —— 它现在必须被忽略，
  // 断言它没有影响快照，等于把「那档已退役」钉住（哪天有人把它读回来，这条会红）。
  assert.deepEqual(JSON.parse(attempt.cost_rule_snapshot), {
    basis: 'UPSTREAM_REPORTED_OR_UNKNOWN', provider: 'custom', channelId: 'configured-channel', model: 'evidence-model', estimatedCostFen: null, capturedAt: JSON.parse(attempt.cost_rule_snapshot).capturedAt,
  });
  assert.ok(!JSON.stringify(attempt).includes('p87-secret'));
  await assert.rejects(async () => await aq('INSERT INTO compute_attempts(id,call_id,attempt,modality,status,sale_snapshot,created_at) VALUES (?,?,?,?,?,?,?)', ['duplicate', attempt.call_id, attempt.attempt, 'TEXT', 'RUNNING', '{}', new Date().toISOString()]));

  await aq("INSERT INTO compute_attempts(id,call_id,attempt,modality,status,sale_snapshot,created_at) VALUES ('unmatched','call-unmatched',1,'TEXT','FAILED','{}',?)", [new Date().toISOString()]);
  const matched = await handleAdmin(adminCtx('days=1&page=1&limit=1&evidenceMatch=MATCHED&callId=' + encodeURIComponent(attempt.call_id)));
  assert.equal(matched.total, 1);
  assert.equal(matched.items.length, 1);
  assert.equal(matched.items[0].callId, attempt.call_id);
  assert.equal(matched.items[0].evidenceMatch, 'MATCHED');
  assert.equal(matched.items[0].clientRequestId, attempt.client_request_id);
  assert.equal(matched.items[0].gatewayLogId, 'gateway-log-87');
  assert.equal(matched.totalPages, 1);
  const unmatched = await handleAdmin(adminCtx('days=1&evidenceMatch=UNMATCHED'));
  assert.equal(unmatched.total, 1);
  assert.equal(unmatched.items[0].callId, 'call-unmatched');
  await assert.rejects(() => handleAdmin(adminCtx('evidenceMatch=INVALID')), error => error?.code === 'INVALID_EVIDENCE_MATCH');

  console.log('P87 compute evidence: request correlation, response/task/usage/gateway IDs, safe snapshots, uniqueness, pagination and filters passed');
} finally {
  globalThis.fetch = originalFetch;
}
