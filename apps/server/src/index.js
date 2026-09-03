import http from 'node:http';
import { PORT } from './config.js';
import { ApiError, corsHeaders, envelope, errors, readJson, requestContext, resolveAuth, sendJson, sendNoContent } from './lib.js';
import { handleAuth } from './routes/auth.js';
import { handleAdmin, handleOrg } from './routes/adminOrg.js';
import { handleStudent } from './routes/student.js';
import { handleAi } from './routes/ai.js';
import { handleAiGeneration } from './routes/aiGeneration.js';
import { handleAdminCommunication, handleOrgCommunication, handlePublicCommunication, handleStudentCommunication } from './routes/communication.js';
import { handleAdminFileAssets, handleOrgFileAssets, handleStudentFileAssets } from './routes/fileAssets.js';
import { handleAdminBillingConfig, handleOrgBillingConfig, handleStudentBillingConfig } from './routes/billingConfig.js';

const bodyMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendNoContent(res, req);
    return;
  }

  const authResult = resolveAuth(req);
  const ctx = {
    ...requestContext(req),
    req,
    res,
    body: {},
    auth: authResult.auth,
    authError: authResult.error,
    setCookie: null,
  };

  try {
    if (bodyMethods.has(ctx.method)) ctx.body = await readJson(req, '2mb');
    if (ctx.pathname === '/health' && ctx.method === 'GET') {
      sendJson(res, 200, envelope({ status: 'ok', service: 'ai-kids-platform', time: new Date().toISOString() }), req);
      return;
    }

    const data = await handlePublicCommunication(ctx)
      ?? await handleAuth(ctx)
      ?? await handleAdmin(ctx)
      ?? await handleAdminCommunication(ctx)
      ?? await handleAdminFileAssets(ctx)
      ?? await handleAdminBillingConfig(ctx)
      ?? await handleOrg(ctx)
      ?? await handleOrgCommunication(ctx)
      ?? await handleOrgFileAssets(ctx)
      ?? await handleOrgBillingConfig(ctx)
      ?? await handleStudentCommunication(ctx)
      ?? await handleStudentFileAssets(ctx)
      ?? await handleStudentBillingConfig(ctx)
      ?? await handleStudent(ctx)
      ?? await handleAi(ctx)
      ?? await handleAiGeneration(ctx);

    if (data === null || data === undefined) throw errors.notFound('接口不存在', 'ROUTE_NOT_FOUND');
    const extraHeaders = ctx.setCookie ? { 'set-cookie': ctx.setCookie } : {};
    sendJson(res, 200, envelope(data), req, extraHeaders);
  } catch (error) {
    const apiError = error instanceof ApiError
      ? error
      : new ApiError(500, 'INTERNAL_ERROR', '服务器内部错误');
    if (!(error instanceof ApiError)) console.error('[API INTERNAL ERROR]', error);
    sendJson(res, apiError.status || 500, apiError.toResponse(), req, ctx.setCookie ? { 'set-cookie': ctx.setCookie } : {});
  }
});

server.listen(PORT, () => {
  console.log(`AI Kids Platform API listening on http://localhost:${PORT}`);
});
