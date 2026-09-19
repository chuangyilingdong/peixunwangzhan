import http from 'node:http';
import { DEPLOYMENT_MODE, PORT } from './config.js';
import { ApiError, corsHeaders, envelope, errors, platformPermissionForPathname, readBodyBuffer, readJson, requestContext, requirePlatformPermission, resolveAuth, sendJson, sendNoContent } from './lib.js';
import { handleAuth } from './routes/auth.js';
import { handleAdmin } from './routes/adminOrg.js';
import { handleOrg } from './routes/orgAdmin.js';
import { handleStudent } from './routes/student.js';
import { handleRuntimeGateway } from './routes/runtimeGateway.js';
import { handleRuntimeSearchGateway } from './routes/runtimeSearchGateway.js';
import { handleStudentRuntime } from './routes/studentRuntime.js';
import { handleAi } from './routes/ai.js';
import { handleAiGeneration, initializeAsyncGenerationQueue } from './routes/aiGeneration.js';
// 2026-09-18：供应商账单两条线整体下线（用户口径）——服务、路由与「官方账单 API 日级定时拉取」
// 一并删除，这里不再有任何账单 scheduler 的 import。
import { handleAdminCommunication, handleOrgCommunication, handlePublicCommunication, handleStudentCommunication, shutdownCommunicationWorkers } from './routes/communication.js';
import { handleAdminFileAssets, handleOrgFileAssets, handleStudentFileAssets, handlePublicFileAssets } from './routes/fileAssets.js';
// 2026-09-13（P4 删积分）：adminCredits.js / websiteCredits.js 两个路由文件已删除（积分体系下线）。
import { handleAdminBillingConfig, handleStudentBillingConfig } from './routes/billingConfig.js';
import { handleVibeCoding } from './routes/vibecoding.js';
import { domainStateContract } from './services/domainState.js';
import { maxUploadBytes } from './services/fileUploadSecurity.js';

const bodyMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const PUBLIC_SITE_URL = String(process.env.PUBLIC_SITE_URL || 'http://localhost:5176').replace(/\/$/, '');
const INTERNAL_TEST = DEPLOYMENT_MODE === 'internal-test';
const API_HOST = INTERNAL_TEST ? '127.0.0.1' : String(process.env.API_HOST || '0.0.0.0');
const PUBLIC_ROUTES = ['/', '/marketplace', '/org', '/works', '/handbook', '/compare', '/download', '/demo', '/terms', '/privacy', '/minors'];

/**
 * 普通 JSON 接口的请求体上限（2MB）与**学生运行时网关**的上限（默认 24MB）分开。
 *
 * 为什么网关那条要大得多（2026-09-17 实测踩到）：dsh 每轮都把整段对话重发一次，
 * 而 agent 干活时会**不停地读自己的截图**（`读取图片` → 图片作为内容块进历史）。
 * 图片按**字节**很大、按 **token** 很小 —— 学生那一轮读了 8 张截图，账本上只有 25k tokens，
 * 但请求体轻松超过 2MB → 整轮被 400 挡掉、学生的活干到一半停住。
 * 我们的网关自己允许「一条消息 4 张图、每张 5.6M 字符」，却让分发层砍到 2MB，本来就不自洽。
 *
 * ⚠️ 这个值必须**小于 nginx 的 `client_max_body_size`**（生产是 30m）：大了就轮不到我们说话，
 * 小也轮不到我们报错（nginx 直接 413，学生会看到一句没头没尾的错）。
 */
const JSON_BODY_LIMIT = '2mb';
const RUNTIME_GATEWAY_BODY_LIMIT = String(process.env.RUNTIME_GATEWAY_BODY_LIMIT || '24mb').trim();
// 桌面客户端交作品（`/api/student/runtime/submit-upload`，2026-09-19）：字节以 base64 装在 JSON 里，
// 2MB 的通用上限连一个 PPT 都装不下。**按路径开额度**，不动全局 —— 放宽全局放宽的是攻击面，
// 不只是善良的上传。24MB 对应解回来约 17MB 的文件，而 `studentRuntime.js` 的 MAX_UPLOAD_BYTES
// 取得比它小一点：为的是"作品太大"这句中文原因由**我们**先说出口，而不是让学生吃一个裸 413。
const RUNTIME_UPLOAD_BODY_LIMIT = String(process.env.RUNTIME_UPLOAD_BODY_LIMIT || '24mb').trim();
const jsonBodyLimitFor = (pathname) => {
  const path = String(pathname || '');
  if (path.startsWith('/api/gateway/')) return RUNTIME_GATEWAY_BODY_LIMIT;
  if (path === '/api/student/runtime/submit-upload') return RUNTIME_UPLOAD_BODY_LIMIT;
  return JSON_BODY_LIMIT;
};

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
      } else ctx.body = await readJson(req, jsonBodyLimitFor(ctx.pathname));
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

    const data = await handleRuntimeGateway(ctx)
      ?? await handleRuntimeSearchGateway(ctx)
      ?? await handlePublicCommunication(ctx)
      ?? await handlePublicFileAssets(ctx)
      ?? await handleAuth(ctx)
      ?? await handleAdmin(ctx)
      ?? await handleAdminCommunication(ctx)
      ?? await handleAdminFileAssets(ctx)
      ?? await handleAdminBillingConfig(ctx)
      ?? await handleOrg(ctx)
      ?? await handleOrgCommunication(ctx)
      ?? await handleOrgFileAssets(ctx)
      ?? await handleStudentCommunication(ctx)
      ?? await handleStudentFileAssets(ctx)
      ?? await handleStudentBillingConfig(ctx)
      ?? await handleVibeCoding(ctx)
      ?? await handleStudentRuntime(ctx)
      ?? await handleStudent(ctx)
      ?? await handleAi(ctx)
      ?? await handleAiGeneration(ctx);

    if (data === null || data === undefined) throw errors.notFound('接口不存在', 'ROUTE_NOT_FOUND');
    if (data && data.__fileResponse) {
      sendFileResponse(res, data, req);
      return;
    }
    // SSE 等自行写响应的处理器：响应已结束，不能再套 JSON 信封
    if (data && data.__streamed) return;
    const extraHeaders = ctx.setCookie ? { 'set-cookie': ctx.setCookie } : {};
    sendJson(res, 200, envelope(data), req, extraHeaders);
  } catch (error) {
    const apiError = error instanceof ApiError
      ? error
      : new ApiError(500, 'INTERNAL_ERROR', '服务器内部错误');
    if (!(error instanceof ApiError)) console.error('[API INTERNAL ERROR]', error);
    // 「请求体过大」必须留痕：它以前是**一声不响**地把整轮对话掐掉（学生只看到运行失败，
    // 日志里连一行都没有），而它恰恰是「AI 干到一半停住」的一个真凶。留下路径、实际上限与
    // nginx 声明的长度，下次一眼能看出是哪一条、差多少。
    if (apiError.code === 'PAYLOAD_TOO_LARGE') {
      console.warn(`[API] 请求体过大被拒：${ctx.method} ${ctx.pathname}（上限 ${jsonBodyLimitFor(ctx.pathname)}，`
        + `nginx 收到的 content-length ${String(ctx.req?.headers?.['content-length'] || '未知')}）`);
    }
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
