import http from 'node:http';
import { DEPLOYMENT_MODE, PORT } from './config.js';
import { ApiError, corsHeaders, envelope, errors, platformPermissionForPathname, readBodyBuffer, readJson, requestContext, requirePlatformPermission, resolveAuth, sendJson, sendNoContent } from './lib.js';
import { handleAuth } from './routes/auth.js';
import { handleAdmin, handleOrg } from './routes/adminOrg.js';
import { handleStudent } from './routes/student.js';
import { handleAi } from './routes/ai.js';
import { handleAiGeneration, initializeAsyncGenerationQueue } from './routes/aiGeneration.js';
import { handleAdminCommunication, handleOrgCommunication, handlePublicCommunication, handleStudentCommunication, shutdownCommunicationWorkers } from './routes/communication.js';
import { handleAdminFileAssets, handleOrgFileAssets, handleStudentFileAssets } from './routes/fileAssets.js';
import { handleAdminBillingConfig, handleOrgBillingConfig, handleStudentBillingConfig } from './routes/billingConfig.js';
import { handlePublicAnalytics, handleAdminAnalytics } from './routes/analytics.js';
import { domainStateContract } from './services/domainState.js';
import { handleFeatureFlags } from './routes/featureFlags.js';
import { maxUploadBytes } from './services/fileUploadSecurity.js';

const bodyMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || 'http://localhost:5176').replace(/\/$/, '');
const INTERNAL_TEST = DEPLOYMENT_MODE === 'internal-test';
const API_HOST = INTERNAL_TEST ? '127.0.0.1' : String(process.env.API_HOST || '0.0.0.0');
const PUBLIC_ROUTES = ['/', '/marketplace', '/courses', '/org', '/works', '/handbook', '/compare', '/download', '/demo', '/terms', '/privacy', '/minors'];

function sendFileResponse(res, fileResponse, req) {
  const headers = { ...corsHeaders(req, fileResponse.headers || {}) };
  res.writeHead(fileResponse.status || 200, headers);
  fileResponse.stream.on('error', () => { if (!res.destroyed) res.destroy(); });
  fileResponse.stream.pipe(res);
}
function sendText(res, status, text, contentType, req) {
  const internalHeaders = INTERNAL_TEST ? { 'x-robots-tag': 'noindex, nofollow, noarchive', 'x-internal-test': 'true' } : {};
  res.writeHead(status, { ...corsHeaders(req, { 'content-type': contentType, 'cache-control': 'public, max-age=3600' }), ...internalHeaders, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
function xmlEscape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function handleSeoAsset(ctx) {
  if (ctx.method !== 'GET') return false;
  if (ctx.pathname === '/robots.txt') {
    const body = INTERNAL_TEST
      ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${PUBLIC_SITE_URL}/sitemap.xml\n`;
    sendText(ctx.res, 200, body, 'text/plain; charset=utf-8', ctx.req); return true;
  }
  if (ctx.pathname === '/sitemap.xml') {
    if (INTERNAL_TEST) { sendText(ctx.res, 404, 'Not found\n', 'text/plain; charset=utf-8', ctx.req); return true; }
    const body = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...PUBLIC_ROUTES.map((route) => `  <url><loc>${xmlEscape(PUBLIC_SITE_URL + route)}</loc></url>`), '</urlset>'].join('\n');
    sendText(ctx.res, 200, body, 'application/xml; charset=utf-8', ctx.req); return true;
  }
  return false;
}

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
    if (bodyMethods.has(ctx.method)) {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (contentType.startsWith('multipart/form-data')) {
        const declaredLength = Number(req.headers['content-length'] || 0);
        // 允许 multipart 边界和字段占用少量额外空间，但不接受明显超限请求。
        const requestLimit = maxUploadBytes() + 1024 * 1024;
        if (Number.isFinite(declaredLength) && declaredLength > requestLimit) throw errors.badRequest('请求体过大', 'PAYLOAD_TOO_LARGE');
        ctx.rawBody = await readBodyBuffer(req, requestLimit);
      } else ctx.body = await readJson(req, '2mb');
    }
    if (handleSeoAsset(ctx)) return;

    const platformPermission = platformPermissionForPathname(ctx.pathname);
    if (platformPermission) requirePlatformPermission(ctx, platformPermission);

    if (ctx.pathname === '/api/meta/domain-states' && ctx.method === 'GET') {
      sendJson(res, 200, envelope(domainStateContract()), req);
      return;
    }

    if (ctx.pathname === '/health' && ctx.method === 'GET') {
      sendJson(res, 200, envelope({ status: 'ok', service: 'ai-kids-platform', time: new Date().toISOString() }), req);
      return;
    }

    const data = await handleFeatureFlags(ctx)
      ?? await handlePublicAnalytics(ctx)
      ?? await handleAdminAnalytics(ctx)
      ?? await handlePublicCommunication(ctx)
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
    if (data && data.__fileResponse) {
      sendFileResponse(res, data, req);
      return;
    }
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

initializeAsyncGenerationQueue();

server.listen(PORT, API_HOST, () => {
  console.log(`AI Kids Platform API listening on http://${API_HOST}:${PORT}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`API server received ${signal}; shutting down`);
  const forcedExit = setTimeout(() => process.exit(1), 10000);
  forcedExit.unref();
  server.close(() => {
    clearTimeout(forcedExit);
    try { shutdownCommunicationWorkers(); }
    catch (error) { console.error('[COMMUNICATION SHUTDOWN ERROR]', error); }
    process.exit(0);
  });
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
