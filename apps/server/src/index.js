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

const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || 'http://localhost:5176').replace(/\/$/, '');
const PUBLIC_ROUTES = ['/', '/marketplace', '/courses', '/org', '/works', '/handbook', '/compare', '/download', '/demo', '/terms', '/privacy', '/minors'];
function sendText(res, status, text, contentType, req) {
  res.writeHead(status, { ...corsHeaders(req, { 'content-type': contentType, 'cache-control': 'public, max-age=3600' }), 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
function xmlEscape(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function handleSeoAsset(ctx) {
  if (ctx.method !== 'GET') return false;
  if (ctx.pathname === '/robots.txt') { sendText(ctx.res, 200, `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${PUBLIC_SITE_URL}/sitemap.xml\n`, 'text/plain; charset=utf-8', ctx.req); return true; }
  if (ctx.pathname === '/sitemap.xml') {
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
    if (bodyMethods.has(ctx.method)) ctx.body = await readJson(req, '2mb');
    if (handleSeoAsset(ctx)) return;

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
